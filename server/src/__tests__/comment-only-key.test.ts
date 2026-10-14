// Slashbin patch: what a comment_only agent key may reach (middleware/comment-only-key.ts).
import { describe, expect, it } from "vitest";
import { commentOnlyKeyDenial } from "../middleware/comment-only-key.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const scope = { kind: "comment_only", issueId } as const;
const req = (method: string, originalUrl: string) => ({ method, originalUrl, url: originalUrl });

describe("comment_only agent key confinement", () => {
  it.each([
    `/api/issues/${issueId}/comments`,
    `/api/issues/${issueId}/comments/`,
    `/api/issues/${issueId.toUpperCase()}/comments?x=1`,
  ])("allows POST %s", (url) => {
    expect(commentOnlyKeyDenial(req("POST", url), scope)).toBeNull();
  });

  it.each([
    ["GET", `/api/issues/${issueId}/comments`],
    ["GET", `/api/issues/${issueId}`],
    ["PATCH", `/api/issues/${issueId}`],
    ["POST", `/api/issues/99999999-9999-4999-8999-999999999999/comments`],
    ["POST", `/api/issues/PAP-580/comments`],
    ["POST", `/api/issues/${issueId}/comments/abc`],
    ["POST", `/api/issues/${issueId}/documents/plan/annotations/t/comments`],
    ["POST", `/api/companies/c/issues`],
    ["GET", `/api/agents/me`],
    ["POST", `/api/agents/a/keys`],
    ["DELETE", `/api/issues/${issueId}/comments`],
  ])("refuses %s %s", (method, url) => {
    expect(commentOnlyKeyDenial(req(method, url), scope)).toMatch(/only post comments/);
  });

  it("leaves every other key scope alone", () => {
    for (const other of [undefined, null, { kind: "standard" } as const]) {
      expect(commentOnlyKeyDenial(req("PATCH", `/api/issues/${issueId}`), other)).toBeNull();
    }
  });
});
