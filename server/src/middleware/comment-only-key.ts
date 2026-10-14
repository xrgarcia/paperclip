// Slashbin patch (slashbin/PATCHES.md): a `comment_only` agent key may post
// comments on the one issue named in its scope and reach nothing else. It exists
// for an agent that acts outside any heartbeat run, on the behalf of the board
// user who minted it, so it is confined here rather than in each route's own
// authorization, which treats an unknown scope as a standard key.
import type { Request } from "express";
import type { AgentApiKeyScope } from "@paperclipai/shared";

export const COMMENT_ONLY_KEY_ROUTE_DENIED = "comment_only_key_route_denied";

function requestPath(req: Pick<Request, "originalUrl" | "url">): string {
  const raw = req.originalUrl || req.url || "";
  const path = raw.split("?")[0]!.split("#")[0]!;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** True when this request is the one thing a comment-only key may do. */
export function commentOnlyKeyAllows(
  req: Pick<Request, "method" | "originalUrl" | "url">,
  scope: Extract<AgentApiKeyScope, { kind: "comment_only" }>,
): boolean {
  return req.method === "POST"
    && requestPath(req).toLowerCase() === `/api/issues/${scope.issueId.toLowerCase()}/comments`;
}

/** The refusal for a comment-only key on any other request, or null. */
export function commentOnlyKeyDenial(
  req: Pick<Request, "method" | "originalUrl" | "url">,
  scope: AgentApiKeyScope | null | undefined,
): string | null {
  if (scope?.kind !== "comment_only") return null;
  if (commentOnlyKeyAllows(req, scope)) return null;
  return "This agent key may only post comments on its one issue";
}
