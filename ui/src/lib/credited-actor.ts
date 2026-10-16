// Slashbin patch (slashbin/PATCHES.md): an activity row a credited board-key request
// logged carries `details.creditedActor` (server middleware/comment-author.ts). The
// feeds show that author; the row's own actor stays the board user, which is what
// the server's rules read. Applied once per client that fetches activity rows
// (api/activity.ts, api/audit.ts). The audit's basic tier strips details, so its
// readers still see the key's user; the CSV export is the raw rows.
type ActorRow = {
  actorType: "agent" | "user" | "system" | "plugin" | null;
  actorId: string | null;
  details: Record<string, unknown> | null;
};

export function withCreditedActor<T extends ActorRow>(row: T): T {
  const credited = row.details?.creditedActor as { type?: unknown; id?: unknown } | undefined;
  if (row.actorType !== "user" || !credited || typeof credited.id !== "string" || !credited.id) return row;
  if (credited.type !== "agent" && credited.type !== "user") return row;
  return { ...row, actorType: credited.type, actorId: credited.id };
}
