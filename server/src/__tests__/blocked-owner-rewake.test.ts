import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issueRecoveryActions, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resetBlockedOwnerRewakeState, rewakeStaleBlockedOwners } from "../services/routable-blocked.ts";

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
      assigneeAgentId: owner === "board" || !("agentId" in owner) ? null : agentId,
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

  it("leaves a stale card its owner does not hold: assigned to another agent or to a person", async () => {
    const { companyId, agentId, card } = await fixture();
    await db.delete(issues);
    const otherAgent = randomUUID();
    await db.insert(agents).values({ id: otherAgent, companyId, name: "Foreman", role: "engineer", status: "idle", adapterType: "codex_local" });
    const onAgent = { ...card("with the Foreman", hoursAgo(5)), assigneeAgentId: otherAgent };
    const onPerson = { ...card("with a person", hoursAgo(5)), assigneeAgentId: null, assigneeUserId: "user-1" };
    const held = card("held by its owner", hoursAgo(5));
    await db.insert(issues).values([onAgent, onPerson, held]);
    const wake = vi.fn(async () => ({ id: randomUUID() }));

    await expect(rewakeStaleBlockedOwners(db, wake, 4, now)).resolves.toBe(1);
    expect(wake.mock.calls.map(([who, o]) => [who, (o as { payload: { issueId: string } }).payload.issueId])).toEqual([[agentId, held.id]]);
    for (const left of [onAgent, onPerson]) {
      const [r] = await db.select().from(issues).where(eq(issues.id, left.id));
      expect(r.blockedOwnerNotifiedAt?.toISOString()).toBe(hoursAgo(5).toISOString());
    }
  });

  it("puts the stamp back on a wake that throws, and still wakes the rest of the batch", async () => {
    const { stale, never } = await fixture();
    const wake = vi.fn(async (_: string, o: unknown) => {
      if ((o as { payload: { issueId: string } }).payload.issueId === stale.id) throw new Error("agent not invokable");
      return { id: randomUUID() };
    });

    await expect(rewakeStaleBlockedOwners(db, wake, 4, now)).resolves.toBe(1);
    const [row] = await db.select().from(issues).where(eq(issues.id, stale.id));
    expect(row.blockedOwnerNotifiedAt?.toISOString()).toBe(stale.blockedOwnerNotifiedAt!.toISOString());
    const [woken] = await db.select().from(issues).where(eq(issues.id, never.id));
    expect(woken.blockedOwnerNotifiedAt?.toISOString()).toBe(now.toISOString());
  });

  it("does nothing when the window is 0", async () => {
    await fixture();
    const wake = vi.fn(async () => undefined);
    await expect(rewakeStaleBlockedOwners(db, wake, 0, now)).resolves.toBe(0);
    expect(wake).not.toHaveBeenCalled();
  });
  it("leaves a card behind a recovery hold to the reconciliation, and still wakes the others", async () => {
    const { companyId, agentId, stale, never } = await fixture();
    // The shape a SIGTERM-interrupted process-adapter run leaves (legacy-execution-recovery.ts).
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: stale.id,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      returnOwnerAgentId: agentId,
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${randomUUID()}`,
      evidence: { runId: randomUUID() },
      nextAction: "Inspect the stopped provider and recorded actions, then reconcile their outcomes before continuing.",
    });
    const wake = vi.fn(async () => ({ id: randomUUID() }));

    await expect(rewakeStaleBlockedOwners(db, wake, 4, now)).resolves.toBe(1);
    expect(wake.mock.calls.map(([, o]) => (o as { payload: { issueId: string } }).payload.issueId)).toEqual([never.id]);
    const [held] = await db.select().from(issues).where(eq(issues.id, stale.id));
    expect(held.blockedOwnerNotifiedAt?.toISOString()).toBe(stale.blockedOwnerNotifiedAt!.toISOString());
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

  it("pages past more than a batch of held cards to the eligible one", async () => {
    const { card, companyId, agentId } = await fixture();
    await db.delete(issues);
    const held = Array.from({ length: 30 }, (_, i) => card(`held ${i}`, hoursAgo(100)));
    const target = card("eligible", hoursAgo(5));
    await db.insert(issues).values([...held, target]);
    await db.insert(issueRecoveryActions).values(held.map((h) => ({
      companyId,
      sourceIssueId: h.id,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      returnOwnerAgentId: agentId,
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${h.id}`,
      evidence: {},
      nextAction: "Reconcile.",
    })));
    const wake = vi.fn(async () => ({ id: randomUUID() }));

    await expect(rewakeStaleBlockedOwners(db, wake, 4, now)).resolves.toBe(1);
    expect((wake.mock.calls[0][1] as { payload: { issueId: string } }).payload.issueId).toBe(target.id);
  });
});
