import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issueRecoveryActions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resetBlockedOwnerRewakeState, rewakeStaleBlockedOwners } from "../services/routable-blocked.ts";
import { getExecutionBlocker } from "../services/execution-blocker.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-owner re-wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("blocked owner re-wake sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const now = new Date("2026-10-19T23:00:00.000Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-rewake-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => resetBlockedOwnerRewakeState());

  afterEach(async () => {
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
    await db.insert(companies).values({ id: companyId, name: "Rewake fixture", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "EM", role: "engineer", status: "idle", adapterType: "codex_local" });
    const card = (title: string, notifiedAt: Date | null, owner: { agentId: string } | "board" = { agentId }) => ({
      id: randomUUID(),
      companyId,
      title,
      status: "blocked",
      unblockDescriptor: { owner, action: `rule on ${title}` },
      blockedTransitionAt: hoursAgo(48),
      blockedOwnerNotifiedAt: notifiedAt,
      updatedAt: hoursAgo(48),
    });
    const stale = card("stale", hoursAgo(5));
    const fresh = card("fresh", hoursAgo(1));
    const board = card("board", hoursAgo(30), "board");
    const never = card("never notified", null);
    await db.insert(issues).values([stale, fresh, board, never]);
    return { companyId, agentId, card, stale, fresh, board, never };
  }

  it("wakes the owner of each stale card once, and leaves fresh and board-owned cards alone", async () => {
    const { agentId, stale, fresh, board, never } = await fixture();
    const wake = vi.fn(async () => ({ id: randomUUID() }));

    await expect(rewakeStaleBlockedOwners(db, wake, 4, now)).resolves.toBe(2);
    const woken = wake.mock.calls.map(([who, opts]) => [who, (opts as { payload: { issueId: string } }).payload.issueId]);
    expect(woken.sort()).toEqual([[agentId, stale.id], [agentId, never.id]].sort());

    const [row] = await db.select().from(issues).where(eq(issues.id, stale.id));
    expect(row.blockedOwnerNotifiedAt?.toISOString()).toBe(now.toISOString());
    for (const untouched of [fresh, board]) {
      const [r] = await db.select().from(issues).where(eq(issues.id, untouched.id));
      expect(r.blockedOwnerNotifiedAt?.toISOString()).toBe(untouched.blockedOwnerNotifiedAt!.toISOString());
    }

    // The next sweep inside the window sends nothing more.
    await expect(rewakeStaleBlockedOwners(db, wake, 4, new Date(now.getTime() + 60_000))).resolves.toBe(0);
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the window is 0", async () => {
    await fixture();
    const wake = vi.fn(async () => undefined);
    await expect(rewakeStaleBlockedOwners(db, wake, 0, now)).resolves.toBe(0);
    expect(wake).not.toHaveBeenCalled();
  });
  // The shape a SIGTERM-interrupted process-adapter run leaves (legacy-execution-recovery.ts).
  const legacyHold = (companyId: string, sourceIssueId: string, returnOwnerAgentId: string, evidence: Record<string, unknown> = {}) => ({
    companyId,
    sourceIssueId,
    kind: "active_run_watchdog",
    status: "active",
    ownerType: "board",
    returnOwnerAgentId,
    cause: "legacy_execution_requires_reconciliation",
    fingerprint: `legacy-execution:${randomUUID()}`,
    evidence: { runId: randomUUID(), ...evidence },
    nextAction: "Inspect the stopped provider and recorded actions, then reconcile their outcomes before continuing.",
  });

  it("starts the owner of a card held past a window on a fresh conversation, and lifts only that hold", async () => {
    const { companyId, agentId, stale, fresh } = await fixture();
    const hold = legacyHold(companyId, stale.id, agentId);
    await db.insert(issueRecoveryActions).values([hold, legacyHold(companyId, fresh.id, agentId)]);
    expect(await getExecutionBlocker(db, companyId, stale.id)).not.toBeNull();
    const wake = vi.fn(async () => ({ id: randomUUID() }));

    await expect(rewakeStaleBlockedOwners(db, wake, 4, now)).resolves.toBe(2);
    const call = wake.mock.calls.find(([, o]) => (o as { payload: { issueId: string } }).payload.issueId === stale.id)!;
    expect((call[1] as { contextSnapshot: Record<string, unknown> }).contextSnapshot).toMatchObject({
      forceFreshSession: true,
      previousRunId: hold.evidence.runId,
    });
    expect(await getExecutionBlocker(db, companyId, stale.id)).toBeNull();
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, stale.id));
    expect(action.evidence.blockedOwnerFreshStart).toMatchObject({ agentId, at: now.toISOString() });
    // Inside its window, the fresh card's hold stands.
    expect(await getExecutionBlocker(db, companyId, fresh.id)).not.toBeNull();
  });

  it("puts the hold back when the fresh-start wake starts no run", async () => {
    const { companyId, agentId, stale } = await fixture();
    await db.insert(issueRecoveryActions).values(legacyHold(companyId, stale.id, agentId));
    const wake = vi.fn(async () => null);

    await expect(rewakeStaleBlockedOwners(db, wake, 4, now)).resolves.toBe(0);
    expect(await getExecutionBlocker(db, companyId, stale.id)).not.toBeNull();
    const [row] = await db.select().from(issues).where(eq(issues.id, stale.id));
    expect(row.blockedOwnerNotifiedAt?.toISOString()).toBe(stale.blockedOwnerNotifiedAt!.toISOString());
  });

  it("never lifts an unsafe-workspace hold", async () => {
    const { companyId, agentId, stale, never } = await fixture();
    await db.insert(issueRecoveryActions).values(legacyHold(companyId, stale.id, agentId, { workspaceRestoreFailure: "restore_unsafe_archive" }));
    const wake = vi.fn(async () => ({ id: randomUUID() }));

    await expect(rewakeStaleBlockedOwners(db, wake, 4, now)).resolves.toBe(1);
    expect(wake.mock.calls.map(([, o]) => (o as { payload: { issueId: string } }).payload.issueId)).toEqual([never.id]);
    expect(await getExecutionBlocker(db, companyId, stale.id)).not.toBeNull();
  });

  it("does not count or stamp a wake that started no run, and does not retry it inside the window", async () => {
    const { stale } = await fixture();
    const wake = vi.fn(async () => null);

    await expect(rewakeStaleBlockedOwners(db, wake, 4, now)).resolves.toBe(0);
    expect(wake).toHaveBeenCalledTimes(2);
    const [row] = await db.select().from(issues).where(eq(issues.id, stale.id));
    expect(row.blockedOwnerNotifiedAt?.toISOString()).toBe(stale.blockedOwnerNotifiedAt!.toISOString());

    await expect(rewakeStaleBlockedOwners(db, wake, 4, new Date(now.getTime() + 60_000))).resolves.toBe(0);
    expect(wake).toHaveBeenCalledTimes(2);
    // A window later, it is tried again.
    await rewakeStaleBlockedOwners(db, wake, 4, new Date(now.getTime() + 4 * 3_600_000 + 60_000));
    expect(wake).toHaveBeenCalledTimes(5); // stale and never again, plus fresh, now past its window too
  });

  it("reaches an agent-owned card behind more than a batch of older board- and user-owned cards", async () => {
    const { card, companyId } = await fixture();
    await db.delete(issues);
    const excluded = Array.from({ length: 30 }, (_, i) => ({
      ...card(`board ${i}`, hoursAgo(100), i % 2 ? "board" : ({ userId: randomUUID() } as never)),
      companyId,
    }));
    const target = card("agent-owned", hoursAgo(5));
    await db.insert(issues).values([...excluded, target]);
    const wake = vi.fn(async () => ({ id: randomUUID() }));

    await expect(rewakeStaleBlockedOwners(db, wake, 4, now)).resolves.toBe(1);
    expect((wake.mock.calls[0][1] as { payload: { issueId: string } }).payload.issueId).toBe(target.id);
  });

  it("pages past more than a batch of cards behind unsafe-workspace holds to the eligible one", async () => {
    const { card, companyId, agentId } = await fixture();
    await db.delete(issues);
    const held = Array.from({ length: 30 }, (_, i) => card(`held ${i}`, hoursAgo(100)));
    const target = card("eligible", hoursAgo(5));
    await db.insert(issues).values([...held, target]);
    await db.insert(issueRecoveryActions).values(held.map((h) =>
      legacyHold(companyId, h.id, agentId, { workspaceRestoreFailure: "restore_unsafe_archive" })));
    const wake = vi.fn(async () => ({ id: randomUUID() }));

    await expect(rewakeStaleBlockedOwners(db, wake, 4, now)).resolves.toBe(1);
    expect((wake.mock.calls[0][1] as { payload: { issueId: string } }).payload.issueId).toBe(target.id);
  });
});
