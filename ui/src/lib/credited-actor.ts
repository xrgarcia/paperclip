// Slashbin patch (slashbin/PATCHES.md): an activity row a credited board-key request
// logged carries `details.creditedActor` (server middleware/comment-author.ts). The
// feed shows that author; the row's own actor stays the board user, which is what
// the server's rules read. Applied once, where the UI fetches activity.
import type { ActivityEvent } from "@paperclipai/shared";

export function withCreditedActor(event: ActivityEvent): ActivityEvent {
  const credited = event.details?.creditedActor as { type?: unknown; id?: unknown } | undefined;
  if (event.actorType !== "user" || !credited || typeof credited.id !== "string" || !credited.id) return event;
  if (credited.type !== "agent" && credited.type !== "user") return event;
  return { ...event, actorType: credited.type, actorId: credited.id };
}
