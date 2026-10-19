// slashbin (EM#625): a bridged (`process`) seat that hands its own card on from
// inside its own run has finished that run. The board must record it as
// succeeded, hold nothing for replay and wake the receiver. Every other stop of
// a reassigned run keeps the upstream cancellation.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { runningProcesses } from "../adapters/index.js";
import { agentRunWritesRevoked, assertAgentRunWriteAllowed, SELF_HANDOFF_COMMIT_WINDOW_MS } from "../agent-run-cancellation.js";
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
  // Review R1: the giver's own executor finishes after the stop. Its late
  // finalization must keep the hand-on markers, so a later receiver admission
  // still recognizes the giver as the handoff source and adopts its queued input.
  it("keeps the hand-on markers through the giver's real executor completion", async () => {
    // A real run acts for the company's responsible user; that user must exist.
    await db.insert(authUsers).values({ id: "operator", name: "Operator", email: "operator@example.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    const s = await seed("process");
    // Drop the fixture's hand-made run; let the real executor run the giver.
    runningProcesses.delete(s.runId);
    children.get(s.runId)!.kill();
    children.delete(s.runId);
    await db.update(issues).set({ executionRunId: null, executionLockedAt: null, executionAgentNameKey: null, status: "todo" })
      .where(eq(issues.id, s.issueId));
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, s.runId));
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] } })
      .where(eq(agents.id, s.giverId));
    const heartbeat = heartbeatService(db);
    const giverRun = await heartbeat.wakeup(s.giverId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: s.issueId }, contextSnapshot: { issueId: s.issueId, taskId: s.issueId, wakeReason: "issue_assigned" },
    });
    await vi.waitFor(async () => {
      const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
      expect(issue!.executionRunId).toBe(giverRun!.id);
      expect(runningProcesses.has(giverRun!.id)).toBe(true);
    }, { timeout: 20_000, interval: 100 });
    const res = await request(app(s.companyId, { agentId: s.giverId, runId: giverRun!.id })).patch(`/api/issues/${s.issueId}`)
      .send({ assigneeAgentId: s.receiverId, comment: "Here is the answer." });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, giverRun!.id));
    expect(run!.status).toBe("succeeded");
    expect(run!.errorCode).toBeNull();
    // The executor's own finalization ran (it writes configFreshness and the presentation decision).
    expect(run!.resultJson).toHaveProperty("configFreshness");
    expect(run!.resultJson).toHaveProperty("presentationDecision");
    expect(run!.resultJson).toMatchObject({ selfHandoff: true, reassignmentStopConfirmed: true });
    expect(typeof run!.resultJson?.issueMutationStopId).toBe("string");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, s.issueId))).toHaveLength(0);

    const [pending] = await db.insert(issueComments).values({
      companyId: s.companyId, issueId: s.issueId, authorType: "user", authorUserId: "operator", body: "One more thing",
    }).returning();
    await db.insert(agentWakeupRequests).values({
      companyId: s.companyId, agentId: s.giverId, source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      payload: { issueId: s.issueId, commentId: pending!.id, _paperclipWakeContext: { issueId: s.issueId, wakeReason: "issue_commented", wakeCommentIds: [pending!.id] } },
    });
    // The first receiver has just been woken (re-wakes are throttled), so a
    // fresh seat takes the card: its admission is the one after completion.
    const lateReceiverId = randomUUID();
    await db.insert(agents).values({
      id: lateReceiverId, companyId: s.companyId, name: "Late Receiver", role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""] }, runtimeConfig: {}, permissions: { canCreateAgents: false, canAssignTasks: true },
    });
    await db.update(issues).set({ assigneeAgentId: lateReceiverId }).where(eq(issues.id, s.issueId));
    const next = await heartbeat.wakeup(lateReceiverId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: s.issueId },
      contextSnapshot: { issueId: s.issueId, taskId: s.issueId, wakeReason: "issue_assigned", interruptedRunId: giverRun!.id },
    });
    expect(next?.contextSnapshot?.wakeCommentIds).toEqual([pending!.id]);
  });
  // Review round 2, R1: succeeded must not hand the giver back its write
  // authority. Only the originating hand-on mutation (its stop id) may commit.
  it("revokes every giver write after a self-handoff except the originating mutation", async () => {
    const s = await seed("process");
    const out = await handOn(s, { kind: "giver" });
    expect(out.run.status).toBe("succeeded");
    expect(agentRunWritesRevoked(out.run)).toBe(true);
    const late = await request(app(s.companyId, { agentId: s.giverId, runId: s.runId })).patch(`/api/issues/${s.issueId}`)
      .send({ status: "done" });
    // Refused: the request middleware (agentRunWritesRevoked) or the receiver's lock stops it first.
    expect([403, 409], JSON.stringify(late.body)).toContain(late.status);
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue!.status).not.toBe("done");
    expect(issue!.assigneeAgentId).toBe(s.receiverId);
    const stopId = out.run.resultJson!.issueMutationStopId as string;
    await db.transaction(async (tx) => {
      await expect(assertAgentRunWriteAllowed(tx as any, s.companyId, { agentId: s.giverId, runId: s.runId }))
        .rejects.toMatchObject({ status: 403 });
      await expect(assertAgentRunWriteAllowed(tx as any, s.companyId, { agentId: s.giverId, runId: s.runId, stopId: randomUUID() }))
        .rejects.toMatchObject({ status: 403 });
      await expect(assertAgentRunWriteAllowed(tx as any, s.companyId, { agentId: s.giverId, runId: s.runId, stopId }))
        .resolves.toBeUndefined();
    });
  });

  // Review round 4, R1: the giver's executor can finalize before the hand-on
  // commits (the card is still in_progress on the giver, nothing pending).
  // Finalization must not originate giver recovery work in that window.
  // The route's self-handoff stop on a giver run by the real executor, drained
  // through finalization, with the issue update not yet committed.
  async function settleGiverBeforeCommit() {
    await db.insert(authUsers).values({ id: "operator", name: "Operator", email: "operator@example.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    const s = await seed("process");
    runningProcesses.delete(s.runId);
    children.get(s.runId)!.kill();
    children.delete(s.runId);
    await db.update(issues).set({ executionRunId: null, executionLockedAt: null, executionAgentNameKey: null, status: "todo" })
      .where(eq(issues.id, s.issueId));
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, s.runId));
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] } })
      .where(eq(agents.id, s.giverId));
    const heartbeat = heartbeatService(db);
    const giverRun = await heartbeat.wakeup(s.giverId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: s.issueId }, contextSnapshot: { issueId: s.issueId, taskId: s.issueId, wakeReason: "issue_assigned" },
    });
    await vi.waitFor(async () => {
      const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
      expect(issue!.executionRunId).toBe(giverRun!.id);
      expect(runningProcesses.has(giverRun!.id)).toBe(true);
    }, { timeout: 20_000, interval: 100 });
    // A replacement giver run, if one is originated, exits at once and is counted.
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", ""] } })
      .where(eq(agents.id, s.giverId));
    // Exactly the route's self-handoff stop, with the issue update not yet committed.
    const settled = await heartbeat.cancelRun(giverRun!.id, "Completed by handing the issue on", {
      settleAs: "succeeded",
      resultJson: { reassignmentStopConfirmed: true, issueMutationStopId: randomUUID(), selfHandoff: true },
      eventMessage: "run completed by handing the issue on",
      eventPayload: { issueId: s.issueId },
    } as any);
    expect(settled?.status).toBe("succeeded");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return { s, heartbeat, giverRun: giverRun! };
  }

  async function expectNoGiverRecovery(g: Awaited<ReturnType<typeof settleGiverBeforeCommit>>) {
    const { s, giverRun } = g;
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue!.assigneeAgentId).toBe(s.giverId);
    expect(issue!.status).toBe("in_progress");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, giverRun.id));
    expect(run!.status).toBe("succeeded");
    expect(run!.resultJson).toHaveProperty("presentationDecision");
    const giverRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, s.giverId));
    expect(giverRuns.map((r) => r.id).sort(), JSON.stringify(giverRuns.map((r) => [r.status, r.contextSnapshot?.wakeReason, r.errorCode])))
      .toEqual([s.runId, giverRun.id].sort());
    const giverWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.giverId));
    expect(giverWakes.filter((w) => w.id !== giverRun.wakeupRequestId && w.status !== "claimed")).toEqual([]);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, s.issueId))).toHaveLength(0);
  }

  // Review round 4, R1: the giver's executor can finalize before the hand-on
  // commits (the card is still in_progress on the giver, nothing pending).
  // Finalization must not originate giver recovery work in that window.
  it("originates no giver recovery when the executor finalizes before the hand-on commits", async () => {
    await expectNoGiverRecovery(await settleGiverBeforeCommit());
  }, 60_000);

  // Review round 5, R1: the periodic stranded sweep can also land between the
  // stop and the commit. It must not originate (or dispatch) a giver repair
  // then; once the commit window has plainly passed without a commit, the
  // hand-on was rejected or lost, and the sweep recovers the card as before.
  it("periodic recovery leaves a self-handoff giver alone until the hand-on could have committed", async () => {
    const g = await settleGiverBeforeCommit();
    await g.heartbeat.reconcileStrandedAssignedIssues();
    await drainHeartbeatRunsToQuiescence(db, g.heartbeat);
    await expectNoGiverRecovery(g);

    // A hand-on that never committed must not strand the card on the giver.
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - SELF_HANDOFF_COMMIT_WINDOW_MS - 60_000) })
      .where(eq(heartbeatRuns.id, g.giverRun.id));
    await g.heartbeat.reconcileStrandedAssignedIssues();
    await drainHeartbeatRunsToQuiescence(db, g.heartbeat);
    const giverRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, g.s.giverId));
    expect(giverRuns.filter((r) => r.contextSnapshot?.wakeReason === "issue_disposition_repair" ||
      r.invocationSource === "automation").length, JSON.stringify(giverRuns.map((r) => [r.status, r.invocationSource, r.contextSnapshot?.wakeReason])))
      .toBeGreaterThan(0);
  }, 60_000);

  // Review round 2, R2: a comment deferred to the giver before the hand-on
  // reaches the receiver; the giver's settlement must not start a new giver run.
  it("delivers a comment deferred before the hand-on to the receiver, never a new giver run", async () => {
    await db.insert(authUsers).values({ id: "operator", name: "Operator", email: "operator@example.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoNothing();
    const s = await seed("process");
    const [pending] = await db.insert(issueComments).values({
      companyId: s.companyId, issueId: s.issueId, authorType: "user", authorUserId: "operator", body: "One more thing",
    }).returning();
    await db.insert(agentWakeupRequests).values({
      companyId: s.companyId, agentId: s.giverId, source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      payload: { issueId: s.issueId, commentId: pending!.id, _paperclipWakeContext: { issueId: s.issueId, wakeReason: "issue_commented", wakeCommentIds: [pending!.id] } },
    });
    const out = await handOn(s, { kind: "giver" });
    expect(out.run.status).toBe("succeeded");
    const giverRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, s.giverId));
    expect(giverRuns.map((r) => r.id)).toEqual([s.runId]);
    const receiverRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, s.receiverId));
    expect(receiverRuns.some((r) => (r.contextSnapshot?.wakeCommentIds as string[] | undefined)?.includes(pending!.id))).toBe(true);
  });
});
