import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { rewakeStaleBlockedOwners } from "../services/routable-blocked.ts";

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

  afterEach(async () => {
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
    return { agentId, stale, fresh, board, never };
  }

  it("wakes the owner of each stale card once, and leaves fresh and board-owned cards alone", async () => {
    const { agentId, stale, fresh, board, never } = await fixture();
    const wake = vi.fn(async () => undefined);

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
});
