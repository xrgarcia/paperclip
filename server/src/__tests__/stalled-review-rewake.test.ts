import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resetBlockedOwnerRewakeState, rewakeStalledReviewHolders } from "../services/routable-blocked.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stalled-review re-wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("stalled in-review re-wake sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const now = new Date("2026-10-20T15:00:00.000Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const woken = (wake: ReturnType<typeof vi.fn>) =>
    wake.mock.calls.map(([who, o]) => [who, (o as { payload: { issueId: string } }).payload.issueId]);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stalled-review-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => resetBlockedOwnerRewakeState());

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stall fixture", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "EM", role: "engineer", status: "idle", adapterType: "codex_local" });
    const card = (title: string, updatedAt: Date, status = "in_review") => ({
      id: randomUUID(),
      companyId,
      title,
      status,
      assigneeAgentId: agentId,
      updatedAt,
    });
    const idle = card("idle in review", hoursAgo(20));
    const fresh = card("changed an hour ago", hoursAgo(1));
    const inProgress = card("in progress", hoursAgo(20), "in_progress");
    const done = card("done", hoursAgo(20), "done");
    const unassigned = { ...card("held by nobody", hoursAgo(20)), assigneeAgentId: null };
    await db.insert(issues).values([idle, fresh, inProgress, done, unassigned]);
    return { companyId, agentId, card, idle, fresh };
  }

  it("wakes the holder of an idle in-review card once a quiet stretch, and nothing else", async () => {
    const { agentId, idle } = await fixture();
    const wake = vi.fn(async () => ({ id: randomUUID() }));

    await expect(rewakeStalledReviewHolders(db, wake, 4, now)).resolves.toBe(1);
    expect(woken(wake)).toEqual([[agentId, idle.id]]);
    const [, opts] = wake.mock.calls[0] as [string, { reason: string; idempotencyKey: string }];
    expect(opts.reason).toBe("issue_review_stalled");
    expect(opts.idempotencyKey).toBe(`issue-review-stalled:${idle.id}:${idle.updatedAt.toISOString()}`);
  });

  it("leaves a card its holder ran on inside the window, and wakes it again once the window passes", async () => {
    const { companyId, agentId, idle } = await fixture();
    await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "succeeded", createdAt: hoursAgo(2),
      contextSnapshot: { wakeReason: "issue_review_stalled", issueId: idle.id, taskId: idle.id },
    });
    const wake = vi.fn(async () => ({ id: randomUUID() }));

    await expect(rewakeStalledReviewHolders(db, wake, 4, now)).resolves.toBe(0);
    await expect(rewakeStalledReviewHolders(db, wake, 4, new Date(now.getTime() + 3 * 3_600_000))).resolves.toBe(1);
    expect(woken(wake)).toEqual([[agentId, idle.id]]);
  });

  it("counts only the holder's own runs: another agent's run on the card does not quiet it", async () => {
    const { companyId, agentId, idle } = await fixture();
    const other = randomUUID();
    await db.insert(agents).values({ id: other, companyId, name: "Foreman", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({
      companyId, agentId: other, status: "succeeded", createdAt: hoursAgo(1),
      contextSnapshot: { issueId: idle.id },
    });
    const wake = vi.fn(async () => ({ id: randomUUID() }));
    await expect(rewakeStalledReviewHolders(db, wake, 4, now)).resolves.toBe(1);
    expect(woken(wake)).toEqual([[agentId, idle.id]]);
  });

  it("passes a card over for a window when the wake starts no run, and still wakes the rest", async () => {
    const { card, idle } = await fixture();
    const second = card("second idle", hoursAgo(10));
    await db.insert(issues).values(second);
    const wake = vi.fn(async (_: string, o: unknown) =>
      (o as { payload: { issueId: string } }).payload.issueId === idle.id ? null : { id: randomUUID() });

    await expect(rewakeStalledReviewHolders(db, wake, 4, now)).resolves.toBe(1);
    // Inside the window the passed-over card is not retried.
    await expect(rewakeStalledReviewHolders(db, wake, 4, new Date(now.getTime() + 60_000))).resolves.toBe(1);
    expect(woken(wake).filter(([, id]) => id === idle.id)).toHaveLength(1);
  });

  it("leaves a card behind a recovery hold, and does nothing when the window is 0", async () => {
    const { companyId, agentId, idle } = await fixture();
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: idle.id,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      returnOwnerAgentId: agentId,
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${randomUUID()}`,
      evidence: { runId: randomUUID() },
      nextAction: "Reconcile before continuing.",
    });
    const wake = vi.fn(async () => ({ id: randomUUID() }));
    await expect(rewakeStalledReviewHolders(db, wake, 4, now)).resolves.toBe(0);
    await expect(rewakeStalledReviewHolders(db, wake, 0, now)).resolves.toBe(0);
    expect(wake).not.toHaveBeenCalled();
  });
});
