// Slashbin patch (slashbin/PATCHES.md): an instance-admin board key may credit a
// comment it posts, and the activity its request logs, to another identity on the
// board, named by one header:
//
//   x-slashbin-comment-author: agent:<agentId> | user:<userId>
//
// For a sync that copies what someone said elsewhere (GitHub) onto a card: the
// comment shows who said it, not whose key carried it, and the activity feed shows
// who acted. Only the comment's author and the activity row's actor change: the
// request still acts as the board user, so authorization, the activity row's
// responsible user and every status, review and reopen rule see the real caller, and an
// admin board key can already write anything an agent can. The header is refused
// on any other caller, and an author that is not on the issue's company is a 422,
// so a write is never silently credited to the key's own user.
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyMemberships } from "@paperclipai/db";
import { forbidden, unprocessable } from "../errors.js";

export const COMMENT_AUTHOR_HEADER = "x-slashbin-comment-author";
export const COMMENT_AUTHOR_DENIED = "comment_author_override_denied";
export const COMMENT_AUTHOR_INVALID = "comment_author_override_invalid";

/** A resolved header: the agent and its company, or the user and the companies they belong to. */
export type CommentAuthorOverride =
  | { kind: "agent"; agentId: string; companyIds: string[] }
  | { kind: "user"; userId: string; companyIds: string[] };

const headerValue = (req: Pick<Request, "headers">): string | null => {
  const raw = req.headers[COMMENT_AUTHOR_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

/** `agent:<id>` / `user:<id>` → its parts, or null when malformed. */
export function parseCommentAuthor(value: string): { kind: "agent" | "user"; id: string } | null {
  const m = /^(agent|user):(\S{1,128})$/.exec(value);
  return m ? { kind: m[1] as "agent" | "user", id: m[2]! } : null;
}

/**
 * For a board-key request: resolve the header onto req.actor.commentAuthor. → an
 * error to fail the request with, or null (no header, or resolved).
 */
export async function resolveCommentAuthor(db: Db, req: Request): Promise<Error | null> {
  const value = headerValue(req);
  if (!value) return null;
  if (req.actor.type !== "board" || req.actor.source !== "board_key" || !req.actor.isInstanceAdmin) {
    return forbidden("Only an instance-admin board key may credit a comment to another author", { code: COMMENT_AUTHOR_DENIED });
  }
  const parsed = parseCommentAuthor(value);
  if (!parsed) return unprocessable(`${COMMENT_AUTHOR_HEADER} must be agent:<id> or user:<id>`, { code: COMMENT_AUTHOR_INVALID });
  if (parsed.kind === "agent") {
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, parsed.id))
      .then((rows) => rows[0] ?? null)
      .catch(() => null);
    if (!agent || agent.status === "terminated") {
      return unprocessable("The comment author is not an active agent on this board", { code: COMMENT_AUTHOR_INVALID });
    }
    req.actor.commentAuthor = { kind: "agent", agentId: agent.id, companyIds: [agent.companyId] };
    return null;
  }
  const rows = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, parsed.id),
      eq(companyMemberships.status, "active"),
    ));
  if (!rows.length) return unprocessable("The comment author is not a member of any company on this board", { code: COMMENT_AUTHOR_INVALID });
  req.actor.commentAuthor = { kind: "user", userId: parsed.id, companyIds: rows.map((r) => r.companyId) };
  return null;
}

type CommentAuthor = {
  agentId?: string;
  userId?: string;
  runId?: string | null;
  onBehalfOfUserId?: string | null;
};

/**
 * The author a comment on an issue in `companyId` is saved under: the credited one
 * when the request names it, else `author` unchanged. Throws when the header was
 * sent but not resolved (a caller other than an admin board key), or the credited
 * author is not on that company.
 */
export function creditedCommentAuthor(req: Request, companyId: string, author: CommentAuthor): CommentAuthor {
  const credited = req.actor.commentAuthor;
  if (!credited) {
    if (headerValue(req)) throw forbidden("Only an instance-admin board key may credit a comment to another author", { code: COMMENT_AUTHOR_DENIED });
    return author;
  }
  if (!credited.companyIds.includes(companyId)) {
    throw unprocessable("The comment author is not on this issue's company", { code: COMMENT_AUTHOR_INVALID });
  }
  return credited.kind === "agent"
    ? { agentId: credited.agentId, runId: null, onBehalfOfUserId: req.actor.userId ?? null }
    : { userId: credited.userId, runId: null };
}

/** The authorType for a comment the request credits, else `fallback`. */
export function creditedCommentAuthorType<T>(req: Request, fallback: T): T | "agent" | "user" {
  return req.actor.commentAuthor?.kind ?? fallback;
}

const creditedRequest = new AsyncLocalStorage<CommentAuthorOverride>();

/** Runs the rest of the request with its credited author in scope, for the activity log. */
export function nextCredited(req: Request, next: NextFunction): void {
  const credited = req.actor.commentAuthor;
  if (credited) creditedRequest.run(credited, next);
  else next();
}

type ActivityActor = { companyId: string; actorType: string; actorId: string; agentId?: string | null };

/**
 * An activity row logged by a credited request, as the credited author: the feed shows
 * who acted, not whose key carried it. Only a row the route logs as the board user
 * moves, and only on the credited author's company; anything else is unchanged.
 */
export function creditedActivityActor<T extends ActivityActor>(input: T): T {
  const credited = creditedRequest.getStore();
  if (!credited || input.actorType !== "user" || !credited.companyIds.includes(input.companyId)) return input;
  return credited.kind === "agent"
    ? ({ ...input, actorType: "agent", actorId: credited.agentId, agentId: credited.agentId } as T)
    : ({ ...input, actorId: credited.userId } as T);
}
