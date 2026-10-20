// slashbin (EM#625): a card handed from seat A to seat B after A's run was
// cancelled. The settle sweep closes A's hold as `cancelled` with replay still
// blocked; B's wakes must run, not be skipped or deferred forever (SLA-1968).
// The same when the sweep settled the hold as `blocked` (the card was still A's)
// and the card was handed on afterwards (SLA-1919, 1973, 1992, EM#683), provided A's
// run stopped for the handoff or a server shutdown. The hold stands for A, for an
// operator Stop or other failure of A, and for an unsafe workspace.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
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
  async function seed(hold: { outcome?: string; status?: string; workspaceRestoreFailure?: string; stopCode?: string; runStatus?: string } = {}) {
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
      status: hold.runStatus ?? "cancelled", errorCode: hold.stopCode ?? "issue_reassigned", runtimeMode: "legacy", runtimeModeResolvedAt: new Date(),
      startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId, taskId: issueId },
      // As production writes a process stop (SLA-1968's giver run); a shutdown interrupt carries no cancellation.
      resultJson: hold.runStatus === "interrupted" ? {}
        : { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Hand me on", status: "todo", priority: "medium",
      assigneeAgentId: receiverId, createdByAgentId: giverId,
    });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: hold.status ?? "resolved",
      outcome: hold.outcome ?? "cancelled", ownerType: "board", returnOwnerAgentId: giverId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${runId}`,
      evidence: {
        runId,
        ...(hold.workspaceRestoreFailure ? { workspaceRestoreFailure: hold.workspaceRestoreFailure } : {}),
        automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked", actionOutcome: "unknown", recordedAt: new Date().toISOString() },
      },
      // The sweep's two settlements (execution-recovery-resolution.ts): not-current -> cancelled, current -> blocked.
      nextAction: (hold.outcome ?? "cancelled") === "blocked"
        ? "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated."
        : "Recovery closed because the task's owner, execution, or status changed. No work was replayed.",
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

  // EM#683: settled while the card was still the giver's, so the hold stands until it is handed on.
  it("keeps a hold the sweep settled as blocked while the card is with the giver", async () => {
    const s = await seed({ outcome: "blocked" });
    await db.update(issues).set({ assigneeAgentId: s.giverId }).where(eq(issues.id, s.issueId));
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toMatchObject({ recoveryActionId: s.actionId });
  });

  it("frees a hold the sweep settled as blocked once the card is handed on", async () => {
    const s = await seed({ outcome: "blocked" });
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toBeNull();
  });

  it("frees a blocked hold whose giver run was interrupted by a server shutdown (SLA-1992)", async () => {
    const s = await seed({ outcome: "blocked", runStatus: "interrupted", stopCode: "server_shutdown_interrupted" });
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toBeNull();
  });

  it("holds a blocked hold again if the card returns to the giver", async () => {
    const s = await seed({ outcome: "blocked" });
    await db.update(issues).set({ assigneeAgentId: s.giverId }).where(eq(issues.id, s.issueId));
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toMatchObject({ recoveryActionId: s.actionId });
  });

  it("keeps a blocked hold after an operator Stop or another failure of the giver, handed on or not", async () => {
    for (const hold of [
      { stopCode: "cancelled" },
      { runStatus: "failed", stopCode: "adapter_failed" },
      { runStatus: "interrupted", stopCode: "cancelled" },
    ]) {
      const s = await seed({ outcome: "blocked", ...hold });
      expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toMatchObject({ recoveryActionId: s.actionId });
    }
  });

  it("keeps a blocked unsafe-workspace hold after the handoff", async () => {
    const s = await seed({ outcome: "blocked", workspaceRestoreFailure: "restore_unsafe_archive" });
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toMatchObject({ recoveryActionId: s.actionId });
  });

  it("keeps an unsafe-workspace hold whoever owns the card", async () => {
    const s = await seed({ workspaceRestoreFailure: "restore_unsafe_archive" });
    expect(await getExecutionBlocker(db, s.companyId, s.issueId)).toMatchObject({ recoveryActionId: s.actionId });
  });

  // Review S2: input saved while the hold applied. The new owner never ran on
  // the card, and nothing new arrives; ordinary recovery must deliver it.
  async function saveComment(s: Awaited<ReturnType<typeof seed>>, agentId: string) {
    await db.insert(authUsers).values({ id: "operator", name: "Operator", email: "operator@example.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    const [comment] = await db.insert(issueComments).values({
      companyId: s.companyId, issueId: s.issueId, authorType: "user", authorUserId: "operator", body: "Saved while held",
    }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId: s.companyId, agentId, source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      payload: { issueId: s.issueId, commentId: comment!.id, _paperclipWakeContext: { issueId: s.issueId, wakeReason: "issue_commented", wakeCommentIds: [comment!.id] } },
    }).returning();
    return { commentId: comment!.id, wakeId: wake!.id };
  }

  async function recover() {
    await heartbeatService(db).resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
  }

  async function runsCarrying(agentId: string, commentId: string) {
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return runs.filter((r) => (r.contextSnapshot?.wakeCommentIds as string[] | undefined)?.includes(commentId));
  }

  it("delivers input saved while held to a new owner who never ran on the card", async () => {
    const s = await seed();
    const saved = await saveComment(s, s.receiverId);
    await recover();
    expect(await runsCarrying(s.receiverId, saved.commentId)).toHaveLength(1);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, saved.wakeId));
    expect(wake!.status).not.toBe("deferred_issue_execution");
    const giverRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, s.giverId));
    expect(giverRuns.map((r) => r.id)).toEqual([s.runId]);
  });

  it("delivers input saved behind a blocked hold once the card is handed on", async () => {
    const s = await seed({ outcome: "blocked" });
    const saved = await saveComment(s, s.receiverId);
    await recover();
    expect(await runsCarrying(s.receiverId, saved.commentId)).toHaveLength(1);
  });

  it("delivers it when the giver's run was interrupted by a server shutdown (SLA-1992)", async () => {
    const s = await seed({ outcome: "blocked", runStatus: "interrupted", stopCode: "server_shutdown_interrupted" });
    const saved = await saveComment(s, s.receiverId);
    await recover();
    expect(await runsCarrying(s.receiverId, saved.commentId)).toHaveLength(1);
  });

  it("delivers it when the new owner's only run was refused at admission", async () => {
    const s = await seed();
    await db.insert(heartbeatRuns).values({
      companyId: s.companyId, agentId: s.receiverId, invocationSource: "on_demand", triggerDetail: "system",
      status: "cancelled", errorCode: "execution_reconciliation_required", runtimeMode: "legacy",
      runtimeModeResolvedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId: s.issueId, taskId: s.issueId },
    });
    const saved = await saveComment(s, s.receiverId);
    await recover();
    expect(await runsCarrying(s.receiverId, saved.commentId)).toHaveLength(1);
  });

  for (const [label, hold] of [
    ["an operator Stop of the previous owner", { stopCode: "cancelled" }],
    ["an active hold", { status: "active" }],
    ["an operator Stop settled as blocked", { outcome: "blocked", stopCode: "cancelled" }],
    ["an unsafe-workspace hold", { workspaceRestoreFailure: "restore_unsafe_archive" }],
  ] as const) {
    it(`keeps saved input waiting behind ${label}`, async () => {
      const s = await seed(hold);
      const saved = await saveComment(s, s.receiverId);
      await recover();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, s.receiverId))).toEqual([]);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, saved.wakeId));
      expect(wake!.status).toBe("deferred_issue_execution");
    });
  }

  it("keeps saved input waiting when the card returns to the owner whose run was stopped", async () => {
    const s = await seed();
    await db.update(issues).set({ assigneeAgentId: s.giverId }).where(eq(issues.id, s.issueId));
    const saved = await saveComment(s, s.giverId);
    await recover();
    expect(await runsCarrying(s.giverId, saved.commentId)).toEqual([]);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, saved.wakeId));
    expect(wake!.status).toBe("deferred_issue_execution");
  });
});
