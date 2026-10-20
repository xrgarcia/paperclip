import { describe, expect, it, vi } from "vitest";
import {
  deliverAgentUnblockNotification,
  ROUTABLE_BLOCKED_ROLLOUT_AT,
  blockedOwnerRewakeHours,
  staleBlockedOwner,
} from "../services/routable-blocked.js";

const agentId = "00000000-0000-4000-8000-000000000001";

function blockedIssue(input: {
  transitionAt?: Date | null;
  notifiedAt?: Date | null;
} = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    status: "blocked",
    assigneeAgentId: agentId as string | null,
    unblockDescriptor: { owner: { agentId }, action: "Review the finding" } as const,
    blockedTransitionAt: input.transitionAt === undefined
      ? new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1)
      : input.transitionAt,
    blockedOwnerNotifiedAt: input.notifiedAt ?? null,
  };
}

describe("routable blocked notifications", () => {
  it("wakes the named agent and records delivery on a prospective transition", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const now = new Date("2026-07-23T18:30:00.000Z");
    const issue = blockedIssue();

    await expect(deliverAgentUnblockNotification({ issue, wakeup, markNotified, now: () => now }))
      .resolves.toBe(true);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt!.toISOString()}`,
      payload: { issueId: issue.id, action: "Review the finding" },
    }));
    expect(markNotified).toHaveBeenCalledWith(now);
  });

  it("leaves pre-existing blocked issues untouched", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);

    await expect(deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() - 1) }),
      wakeup,
      markNotified,
    })).resolves.toBe(false);
    expect(wakeup).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it("deduplicates one transition and notifies again after a blocked flap", async () => {
    const wakeup = vi.fn(async () => undefined);
    const markNotified = vi.fn(async () => undefined);
    const firstTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 1);
    const secondTransition = new Date(ROUTABLE_BLOCKED_ROLLOUT_AT.getTime() + 2);

    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: firstTransition, notifiedAt: new Date() }),
      wakeup,
      markNotified,
    });
    await deliverAgentUnblockNotification({
      issue: blockedIssue({ transitionAt: secondTransition }),
      wakeup,
      markNotified,
    });

    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: expect.stringContaining(secondTransition.toISOString()),
    });
  });
});

describe("stale blocked owner re-wake", () => {
  const now = new Date("2026-10-19T23:00:00.000Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it("wakes the owning agent again once the last wake is older than the window", () => {
    const issue = blockedIssue({ transitionAt: hoursAgo(30), notifiedAt: hoursAgo(5) });
    expect(staleBlockedOwner(issue, now, 4)).toEqual({ agentId, since: hoursAgo(5) });
  });

  it("waits inside the window", () => {
    expect(staleBlockedOwner(blockedIssue({ transitionAt: hoursAgo(30), notifiedAt: hoursAgo(3) }), now, 4)).toBeNull();
  });

  it("counts from entering Blocked when no wake was ever sent", () => {
    expect(staleBlockedOwner(blockedIssue({ transitionAt: hoursAgo(50) }), now, 4)).toEqual({ agentId, since: hoursAgo(50) });
  });

  it("leaves a card its owner does not hold alone: dispatch would cancel the run", () => {
    const old = blockedIssue({ transitionAt: hoursAgo(30), notifiedAt: hoursAgo(5) });
    expect(staleBlockedOwner({ ...old, assigneeAgentId: "00000000-0000-4000-8000-000000000009" }, now, 4)).toBeNull();
    expect(staleBlockedOwner({ ...old, assigneeAgentId: null }, now, 4)).toBeNull();
  });

  it("leaves a board-owned card, a card with a run on it, and a disabled window alone", () => {
    const old = blockedIssue({ transitionAt: hoursAgo(50), notifiedAt: hoursAgo(50) });
    expect(staleBlockedOwner({ ...old, unblockDescriptor: { owner: "board", action: "Ray decides" } }, now, 4)).toBeNull();
    expect(staleBlockedOwner({ ...old, executionRunId: "00000000-0000-4000-8000-000000000003" }, now, 4)).toBeNull();
    expect(staleBlockedOwner(old, now, 0)).toBeNull();
    expect(staleBlockedOwner({ ...old, status: "todo" }, now, 4)).toBeNull();
  });
});

describe("blocked owner re-wake window", () => {
  it("defaults to 4 hours, reads the variable, and turns off at 0 or junk", () => {
    expect(blockedOwnerRewakeHours({})).toBe(4);
    expect(blockedOwnerRewakeHours({ PAPERCLIP_BLOCKED_OWNER_REWAKE_HOURS: "12" })).toBe(12);
    expect(blockedOwnerRewakeHours({ PAPERCLIP_BLOCKED_OWNER_REWAKE_HOURS: "0" })).toBe(0);
    expect(blockedOwnerRewakeHours({ PAPERCLIP_BLOCKED_OWNER_REWAKE_HOURS: "soon" })).toBe(0);
  });
});
