// slashbin (EM#625): a card handed from seat A to seat B after A's run was
// cancelled. The settle sweep closes A's hold as `cancelled` with replay still
// blocked; B's wakes must run, not be skipped or deferred forever (SLA-1968).
// The hold stands for A, for a hold the sweep settled as `blocked`, and for an
// unsafe workspace.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("slashbin handed-on hold", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-handed-on-hold-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function boardApp(companyId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board", source: "session", userId: "operator", companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  // The state SLA-1968 was left in: A's run cancelled by the reassignment, the
  // sweep's not-current closure on its hold, the card now on B.
  async function seed(hold: { outcome?: string; workspaceRestoreFailure?: string } = {}) {
    const companyId = randomUUID();
    const [giverId, receiverId] = [randomUUID(), randomUUID()];
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Handed On", issuePrefix: `H${companyId.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "operator",
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "operator", status: "active", membershipRole: "operator",
    });
    const agent = (id: string, name: string) => ({
      id, companyId, name, role: "engineer", status: "idle" as const, adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""] }, runtimeConfig: {},
      permissions: { canCreateAgents: false, canAssignTasks: true },
    });
    await db.insert(agents).values([agent(giverId, "Giver"), agent(receiverId, "Receiver")]);
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: giverId, invocationSource: "assignment", triggerDetail: "system",
      status: "cancelled", errorCode: "issue_reassigned", runtimeMode: "legacy", runtimeModeResolvedAt: new Date(),
      startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId, taskId: issueId },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Hand me on", status: "todo", priority: "medium",
      assigneeAgentId: receiverId, createdByAgentId: giverId,
    });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "resolved",
      outcome: hold.outcome ?? "cancelled", ownerType: "board", returnOwnerAgentId: giverId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${runId}`,
      evidence: {
        runId,
        ...(hold.workspaceRestoreFailure ? { workspaceRestoreFailure: hold.workspaceRestoreFailure } : {}),
        automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked", actionOutcome: "unknown" },
      },
      nextAction: "Recovery closed because the task's owner, execution, or status changed. No work was replayed.",
      resolvedAt: new Date(),
    }).returning();
    return { companyId, giverId, receiverId, issueId, runId, actionId: action!.id };
  }

  it("does not hold the card against its new owner", async () => {
    const s = await seed();
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toBeNull();
  });

  it("wakes the new owner when the board assigns it, instead of skipping the wake", async () => {
    const s = await seed();
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, s.issueId));
    const res = await request(boardApp(s.companyId)).patch(`/api/issues/${s.issueId}`)
      .send({ assigneeAgentId: s.receiverId, status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.receiverId));
    expect(wakes.length).toBeGreaterThan(0);
    expect(wakes.filter((w) => ["deferred_issue_execution", "skipped"].includes(w.status))).toEqual([]);
  });

  it("holds the card again if it returns to the owner whose run was stopped", async () => {
    const s = await seed();
    await db.update(issues).set({ assigneeAgentId: s.giverId }).where(eq(issues.id, s.issueId));
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toMatchObject({ recoveryActionId: s.actionId });
  });

  it("keeps a hold the sweep settled as blocked", async () => {
    const s = await seed({ outcome: "blocked" });
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toMatchObject({ recoveryActionId: s.actionId });
  });

  it("keeps an unsafe-workspace hold whoever owns the card", async () => {
    const s = await seed({ workspaceRestoreFailure: "restore_unsafe_archive" });
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toMatchObject({ recoveryActionId: s.actionId });
  });
});
