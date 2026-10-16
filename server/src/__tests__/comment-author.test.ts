// Slashbin patch: resolving x-slashbin-comment-author (middleware/comment-author.ts).
import { describe, expect, it } from "vitest";
import { parseCommentAuthor, resolveCommentAuthor } from "../middleware/comment-author.js";

const AGENT = "44444444-4444-4444-8444-444444444444";
// select().from().where() → a thenable of `rows`, as drizzle returns.
const fakeDb = (rows: unknown[]) => {
  const chain: any = { select: () => chain, from: () => chain, where: () => Promise.resolve(rows) };
  return chain;
};
const req = (actor: Record<string, unknown>, value?: string) =>
  ({ headers: value === undefined ? {} : { "x-slashbin-comment-author": value }, actor }) as any;
const adminKey = { type: "board", userId: "ray", source: "board_key", isInstanceAdmin: true };

describe("x-slashbin-comment-author", () => {
  it("parses agent:<id> and user:<id> only", () => {
    expect(parseCommentAuthor(`agent:${AGENT}`)).toEqual({ kind: "agent", id: AGENT });
    expect(parseCommentAuthor("user:abc")).toEqual({ kind: "user", id: "abc" });
    for (const bad of ["agent:", "board:x", AGENT, "agent: x", "user:a b"]) expect(parseCommentAuthor(bad)).toBeNull();
  });

  it("is a no-op without the header", async () => {
    const r = req({ ...adminKey });
    expect(await resolveCommentAuthor(fakeDb([]), r)).toBeNull();
    expect(r.actor.commentAuthor).toBeUndefined();
  });

  it.each([
    ["a session", { ...adminKey, source: "session" }],
    ["a non-admin board key", { ...adminKey, isInstanceAdmin: false }],
    ["an agent key", { type: "agent", agentId: AGENT, source: "agent_key" }],
  ])("refuses %s", async (_name, actor) => {
    const err: any = await resolveCommentAuthor(fakeDb([]), req(actor, `agent:${AGENT}`));
    expect(err?.status).toBe(403);
  });

  it("resolves an active agent to its company", async () => {
    const r = req({ ...adminKey }, `agent:${AGENT}`);
    expect(await resolveCommentAuthor(fakeDb([{ id: AGENT, companyId: "company-1", status: "idle" }]), r)).toBeNull();
    expect(r.actor.commentAuthor).toEqual({ kind: "agent", agentId: AGENT, companyIds: ["company-1"] });
  });

  it.each([
    ["missing", []],
    ["terminated", [{ id: AGENT, companyId: "company-1", status: "terminated" }]],
  ])("refuses a %s agent", async (_name, rows) => {
    const err: any = await resolveCommentAuthor(fakeDb(rows), req({ ...adminKey }, `agent:${AGENT}`));
    expect(err?.status).toBe(422);
  });

  it("resolves a user to the companies they belong to, and refuses one in none", async () => {
    const r = req({ ...adminKey }, "user:sam");
    expect(await resolveCommentAuthor(fakeDb([{ companyId: "company-1" }]), r)).toBeNull();
    expect(r.actor.commentAuthor).toEqual({ kind: "user", userId: "sam", companyIds: ["company-1"] });
    const err: any = await resolveCommentAuthor(fakeDb([]), req({ ...adminKey }, "user:nobody"));
    expect(err?.status).toBe(422);
  });

  it("refuses a malformed value", async () => {
    const err: any = await resolveCommentAuthor(fakeDb([]), req({ ...adminKey }, "Foreman"));
    expect(err?.status).toBe(422);
  });
});
