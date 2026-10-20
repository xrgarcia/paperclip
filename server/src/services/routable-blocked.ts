import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { executionBlockerPredicate, getExecutionBlocker } from "./execution-blocker.js";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

type RoutableBlockedIssue = {
  id: string;
  status: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
};

type ProspectiveBlockedIssue = RoutableBlockedIssue & {
  status: "blocked";
  blockedTransitionAt: Date;
};

export function isProspectiveBlockedTransition(issue: RoutableBlockedIssue): issue is ProspectiveBlockedIssue {
  return issue.status === "blocked" &&
    Boolean(issue.blockedTransitionAt && issue.blockedTransitionAt >= ROUTABLE_BLOCKED_ROLLOUT_AT);
}

export async function deliverAgentUnblockNotification(input: {
  issue: RoutableBlockedIssue;
  wakeup: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_unblock_requested";
    idempotencyKey: string;
    payload: { issueId: string; action: string };
    contextSnapshot: { wakeReason: "issue_unblock_requested"; issueId: string; taskId: string };
  }) => Promise<unknown>;
  markNotified: (notifiedAt: Date) => Promise<unknown>;
  now?: () => Date;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return false;
  }

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return false;

  await input.wakeup(owner.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_unblock_requested",
    idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt.toISOString()}`,
    payload: { issueId: issue.id, action: issue.unblockDescriptor.action },
    contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: issue.id, taskId: issue.id },
  });
  await input.markNotified((input.now ?? (() => new Date()))());
  return true;
}

/**
 * Slashbin patch: the blocked-owner wake above fires once, on entry. A wake that
 * is lost (a run interrupted by a restart: jerky_service#200's EM scope ruling,
 * SLA-1992, 2026-10-19) or answered by handing the work to a person leaves the
 * card blocked with nothing to wake its owner again. Past `hours` since the last
 * wake (or since it entered Blocked, when none was sent), the owning agent is
 * woken again; it resolves the card, hands it up, or is woken again `hours` later.
 * A card owned by the board, or with a run on it now, is left alone. So is one
 * its owner does not hold: dispatch cancels a run for an agent that is not the
 * card's assignee (issue_assignee_changed), so the owner could not be reached on it.
 */
export function staleBlockedOwner(
  issue: RoutableBlockedIssue & { assigneeAgentId?: string | null; executionRunId?: string | null; updatedAt?: Date | null },
  now: Date,
  hours: number,
): { agentId: string; since: Date } | null {
  if (hours <= 0 || issue.status !== "blocked" || issue.executionRunId) return null;
  const owner = issue.unblockDescriptor?.owner;
  if (!owner || owner === "board" || !("agentId" in owner) || issue.assigneeAgentId !== owner.agentId) return null;
  const since = issue.blockedOwnerNotifiedAt ?? issue.blockedTransitionAt ?? issue.updatedAt ?? null;
  if (!since || now.getTime() - since.getTime() < hours * 3_600_000) return null;
  return { agentId: owner.agentId, since };
}

// Cards a sweep passed over (behind a recovery hold, or a wake that started no
// run), with when: kept out of later batches for one window so they neither
// starve the cards behind them nor get retried every minute. Per process; a
// restart costs at most one more attempt each.
const passedOver = new Map<string, number>();

export async function rewakeStaleBlockedOwners(
  db: Db,
  wake: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_unblock_requested";
    idempotencyKey: string;
    payload: { issueId: string; action: string; rewake: true };
    requestedByActorType: "system";
    requestedByActorId: string;
    contextSnapshot: { wakeReason: "issue_unblock_requested"; issueId: string; taskId: string };
  }) => Promise<unknown>,
  hours: number,
  now = new Date(),
) {
  if (hours <= 0) return 0;
  const windowMs = hours * 3_600_000;
  for (const [id, at] of passedOver) if (now.getTime() - at >= windowMs) passedOver.delete(id);
  const cutoff = new Date(now.getTime() - windowMs);
  const since = sql`coalesce(${issues.blockedOwnerNotifiedAt}, ${issues.blockedTransitionAt}, ${issues.updatedAt})`;
  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      unblockDescriptor: issues.unblockDescriptor,
      blockedTransitionAt: issues.blockedTransitionAt,
      blockedOwnerNotifiedAt: issues.blockedOwnerNotifiedAt,
      executionRunId: issues.executionRunId,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.status, "blocked"),
        isNull(issues.hiddenAt),
        isNull(issues.executionRunId),
        // Only cards their owning agent holds take a batch slot: board and user
        // owners are never woken here, and an owner that is not the assignee
        // would have its run cancelled at dispatch.
        sql`${issues.unblockDescriptor}->'owner'->>'agentId' = ${issues.assigneeAgentId}::text`,
        sql`${since} < ${cutoff.toISOString()}::timestamptz`,
        // A card behind a recovery hold waits on its reconciliation, which the
        // board performs; deliverReconciledExecutions then wakes the owner with
        // an authorized continuation. A system wake cannot pass the hold
        // (admitExplicitNativeContinuation admits users only), so it is not tried.
        sql`not exists (select 1 from ${issueRecoveryActions} where ${issueRecoveryActions.companyId} = ${issues.companyId} and ${issueRecoveryActions.sourceIssueId} = ${issues.id} and ${executionBlockerPredicate()})`,
        passedOver.size ? notInArray(issues.id, [...passedOver.keys()]) : undefined,
      ),
    )
    .orderBy(asc(since))
    .limit(25);
  let woken = 0;
  for (const issue of rows) {
    const stale = staleBlockedOwner(issue, now, hours);
    if (!stale) continue;
    // A blocker the SQL cannot see (conversation ownership) would only defer the wake.
    if (await getExecutionBlocker(db, issue.companyId, issue.id)) {
      passedOver.set(issue.id, now.getTime());
      continue;
    }
    // Claim the nudge first: one wake per window, however many sweeps see the card.
    const claimed = await db
      .update(issues)
      .set({ blockedOwnerNotifiedAt: now })
      .where(
        and(
          eq(issues.companyId, issue.companyId),
          eq(issues.id, issue.id),
          eq(issues.status, "blocked"),
          eq(issues.assigneeAgentId, stale.agentId),
          issue.blockedOwnerNotifiedAt
            ? eq(issues.blockedOwnerNotifiedAt, issue.blockedOwnerNotifiedAt)
            : isNull(issues.blockedOwnerNotifiedAt),
        ),
      )
      .returning({ id: issues.id });
    if (!claimed.length) continue;
    let run: unknown = null;
    try {
      run = await wake(stale.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_unblock_requested",
        idempotencyKey: `issue-unblock-rewake:${issue.id}:${stale.since.toISOString()}`,
        payload: { issueId: issue.id, action: issue.unblockDescriptor!.action, rewake: true },
        requestedByActorType: "system",
        requestedByActorId: "blocked-owner-rewake",
        contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: issue.id, taskId: issue.id },
      });
    } catch (err) {
      logger.warn({ err, issueId: issue.id, agentId: stale.agentId }, "blocked-owner re-wake failed");
    }
    if (run) {
      woken++;
      continue;
    }
    // Deferred, skipped or failed: no run started, so the owner was not notified. Put the
    // stamp back and pass the card over for a window.
    await db
      .update(issues)
      .set({ blockedOwnerNotifiedAt: issue.blockedOwnerNotifiedAt ?? null })
      .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, issue.id), eq(issues.blockedOwnerNotifiedAt, now)));
    passedOver.set(issue.id, now.getTime());
    logger.warn({ issueId: issue.id, agentId: stale.agentId }, "blocked-owner re-wake started no run; retrying after one window");
  }
  return woken;
}

/** Test seam: forget the cards earlier sweeps passed over. */
export function resetBlockedOwnerRewakeState() {
  passedOver.clear();
  lastRewakeSweepAt = 0;
}

/** Hours a blocked card waits before its owning agent is woken again; 0 turns it off. */
export function blockedOwnerRewakeHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCLIP_BLOCKED_OWNER_REWAKE_HOURS;
  if (raw === undefined || raw.trim() === "") return 4;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours : 0;
}

let lastRewakeSweepAt = 0;

/** rewakeStaleBlockedOwners at most once a minute, however often the caller's timer ticks. */
export async function rewakeStaleBlockedOwnersOnSchedule(
  db: Db,
  wake: Parameters<typeof rewakeStaleBlockedOwners>[1],
  now = new Date(),
) {
  if (now.getTime() - lastRewakeSweepAt < 60_000) return 0;
  lastRewakeSweepAt = now.getTime();
  return rewakeStaleBlockedOwners(db, wake, blockedOwnerRewakeHours(), now);
}
