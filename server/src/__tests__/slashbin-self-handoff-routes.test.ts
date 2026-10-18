// slashbin (EM#625): a bridged (`process`) seat that hands its own card on from
// inside its own run has finished that run. The board must record it as
// succeeded, hold nothing for replay and wake the receiver. Every other stop of
// a reassigned run keeps the upstream cancellation.
import { spawn, type ChildProcess } from "node:child_process";
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
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("slashbin self-handoff run accounting", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const children = new Map<string, ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-handoff-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    for (const [id, child] of children) {
      runningProcesses.delete(id);
      child.kill();
    }
    children.clear();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Actor = { kind: "giver" } | { kind: "board" } | { kind: "other" };

  function app(companyId: string, actor: { agentId: string; runId: string } | null) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: actor ? "agent" : "board",
        ...(actor ? { ...actor, companyId } : {}),
        source: "session",
        userId: "operator",
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seed(giverAdapter: string) {
    const companyId = randomUUID();
    const [giverId, receiverId, otherId] = [randomUUID(), randomUUID(), randomUUID()];
    const issueId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const wakeId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Self Handoff", issuePrefix: `S${companyId.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "operator",
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "operator", status: "active", membershipRole: "operator",
    });
    const agent = (id: string, name: string, adapterType: string, role = "engineer") => ({
      id, companyId, name, role, status: "idle" as const, adapterType,
      // A receiver that actually runs: its wake must reach a real, clean run.
      adapterConfig: { command: process.execPath, args: ["-e", ""] }, runtimeConfig: {}, permissions: { canCreateAgents: false, canAssignTasks: true },
    });
    await db.insert(agents).values([
      agent(giverId, "Giver", giverAdapter),
      agent(receiverId, "Receiver", "process"),
      // The CEO may move another seat's live checkout (tasks:manage_active_checkouts).
      agent(otherId, "Other", "process", "ceo"),
    ]);
    await db.insert(agentWakeupRequests).values({
      id: wakeId, companyId, agentId: giverId, source: "assignment", status: "claimed",
    });
    await db.insert(heartbeatRuns).values([
      {
        id: runId, companyId, agentId: giverId, invocationSource: "assignment", triggerDetail: "system",
        status: "running", runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), wakeupRequestId: wakeId,
        startedAt: new Date(), contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      },
      {
        id: otherRunId, companyId, agentId: otherId, invocationSource: "on_demand", triggerDetail: "system",
        status: "running", runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), startedAt: new Date(),
        contextSnapshot: { issueId: randomUUID() },
      },
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, title: "Hand me on", status: "in_progress", priority: "medium",
      assigneeAgentId: giverId, createdByAgentId: receiverId, executionRunId: runId,
      executionAgentNameKey: "giver", executionLockedAt: new Date(),
    });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.set(runId, child);
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: null });
    return { companyId, giverId, receiverId, otherId, issueId, runId, otherRunId };
  }

  async function handOn(s: Awaited<ReturnType<typeof seed>>, actor: Actor) {
    const who = actor.kind === "giver" ? { agentId: s.giverId, runId: s.runId }
      : actor.kind === "other" ? { agentId: s.otherId, runId: s.otherRunId } : null;
    const res = await request(app(s.companyId, who)).patch(`/api/issues/${s.issueId}`)
      .send({ assigneeAgentId: s.receiverId, comment: "Here is the answer." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The receiver's wake is dispatched fire-and-forget; let it settle first.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.runId));
    const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, s.issueId));
    const deferred = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.receiverId)))
      .filter((w) => w.status === "deferred_issue_execution");
    const receiverWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.receiverId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, s.issueId));
    return { run, holds, deferred, receiverWakes, comments };
  }

  it("settles a process seat's own hand-on as succeeded, holds nothing and wakes the receiver", async () => {
    const s = await seed("process");
    const out = await handOn(s, { kind: "giver" });
    expect(out.run.status).toBe("succeeded");
    expect(out.run.errorCode).toBeNull();
    expect(out.run.resultJson).toMatchObject({ selfHandoff: true, reassignmentStopConfirmed: true });
    expect(out.holds).toHaveLength(0);
    expect(out.deferred).toHaveLength(0);
    expect(out.receiverWakes.length).toBeGreaterThan(0);
    const receiverRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, s.receiverId));
    expect(receiverRuns.map((r) => r.status)).toContain("succeeded");
    expect(out.comments.map((c) => c.body)).toEqual(["Here is the answer."]);
    expect(children.get(s.runId)!.killed || children.get(s.runId)!.exitCode !== null || children.get(s.runId)!.signalCode !== null).toBe(true);
  });

  it("keeps the cancellation when the board reassigns the card", async () => {
    const s = await seed("process");
    const out = await handOn(s, { kind: "board" });
    expect(out.run.status).toBe("cancelled");
    expect(out.run.errorCode).toBe("issue_reassigned");
    expect(out.run.resultJson?.selfHandoff).toBeUndefined();
  });

  it("keeps the cancellation for a codex_local seat's own reassignment", async () => {
    const s = await seed("codex_local");
    const out = await handOn(s, { kind: "giver" });
    expect(out.run.status).toBe("cancelled");
    expect(out.run.errorCode).toBe("issue_reassigned");
  });

  it("keeps the cancellation when another agent reassigns a process seat's card", async () => {
    const s = await seed("process");
    const out = await handOn(s, { kind: "other" });
    expect(out.run.status).toBe("cancelled");
    expect(out.run.errorCode).toBe("issue_reassigned");
  });
});
