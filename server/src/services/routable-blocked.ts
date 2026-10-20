import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
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

/**
 * Slashbin patch: an agent's in-review card has no wake at all once it is there.
 * The bridge's inbox lists todo, in_progress and blocked only, so a card the
 * agent holds in review waits on that agent and nothing tells it so
 * (jerky_service#193, #201, #203, #207: four co-release cards held by the EM's
 * own outcome gate, idle with no run until the owner asked, 2026-10-19). Past
 * `hours` with no change to the card and no run on it by its assignee, the
 * assignee is woken on it; it moves the card, says why it waits, or is woken
 * again `hours` after its last word. A card with a run on it now, or behind a
 * recovery hold, is left alone.
 */
const stalledPassedOver = new Map<string, number>();

export async function rewakeStalledReviewHolders(
  db: Db,
  wake: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_review_stalled";
    idempotencyKey: string;
    payload: { issueId: string; rewake: true };
    requestedByActorType: "system";
    requestedByActorId: string;
    contextSnapshot: { wakeReason: "issue_review_stalled"; issueId: string; taskId: string };
  }) => Promise<unknown>,
  hours: number,
  now = new Date(),
) {
  if (hours <= 0) return 0;
  const windowMs = hours * 3_600_000;
  for (const [id, at] of stalledPassedOver) if (now.getTime() - at >= windowMs) stalledPassedOver.delete(id);
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  const rows = await db
    .select({ id: issues.id, companyId: issues.companyId, assigneeAgentId: issues.assigneeAgentId, updatedAt: issues.updatedAt })
    .from(issues)
    .where(
      and(
        eq(issues.status, "in_review"),
        isNull(issues.hiddenAt),
        isNull(issues.executionRunId),
        sql`${issues.assigneeAgentId} is not null`,
        sql`${issues.updatedAt} < ${cutoff}::timestamptz`,
        // A run by the assignee on this card inside the window is the card being looked at.
        sql`not exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.companyId} = ${issues.companyId} and ${heartbeatRuns.agentId} = ${issues.assigneeAgentId} and (${heartbeatRuns.contextSnapshot} ->> 'issueId') = ${issues.id}::text and ${heartbeatRuns.createdAt} >= ${cutoff}::timestamptz)`,
        sql`not exists (select 1 from ${issueRecoveryActions} where ${issueRecoveryActions.companyId} = ${issues.companyId} and ${issueRecoveryActions.sourceIssueId} = ${issues.id} and ${executionBlockerPredicate()})`,
        stalledPassedOver.size ? notInArray(issues.id, [...stalledPassedOver.keys()]) : undefined,
      ),
    )
    .orderBy(asc(issues.updatedAt))
    .limit(25);
  let woken = 0;
  for (const issue of rows) {
    const agentId = issue.assigneeAgentId!;
    if (await getExecutionBlocker(db, issue.companyId, issue.id)) {
      stalledPassedOver.set(issue.id, now.getTime());
      continue;
    }
    let run: unknown = null;
    try {
      run = await wake(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_review_stalled",
        // One wake per quiet stretch: the run, or the comment it ends on, starts the next.
        idempotencyKey: `issue-review-stalled:${issue.id}:${issue.updatedAt.toISOString()}`,
        payload: { issueId: issue.id, rewake: true },
        requestedByActorType: "system",
        requestedByActorId: "stalled-review-rewake",
        contextSnapshot: { wakeReason: "issue_review_stalled", issueId: issue.id, taskId: issue.id },
      });
    } catch (err) {
      logger.warn({ err, issueId: issue.id, agentId }, "stalled-review re-wake failed");
    }
    if (run) {
      woken++;
      continue;
    }
    stalledPassedOver.set(issue.id, now.getTime());
    logger.warn({ issueId: issue.id, agentId }, "stalled-review re-wake started no run; retrying after one window");
  }
  return woken;
}

/** Test seam: forget the cards earlier sweeps passed over. */
export function resetBlockedOwnerRewakeState() {
  passedOver.clear();
  stalledPassedOver.clear();
  lastRewakeSweepAt = 0;
}

/** Hours a blocked (or in-review) card waits before its holding agent is woken again; 0 turns it off. */
export function blockedOwnerRewakeHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAPERCLIP_BLOCKED_OWNER_REWAKE_HOURS;
  if (raw === undefined || raw.trim() === "") return 4;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours : 0;
}

let lastRewakeSweepAt = 0;

/** Both re-wake sweeps at most once a minute, however often the caller's timer ticks. */
export async function rewakeStaleBlockedOwnersOnSchedule(
  db: Db,
  wake: Parameters<typeof rewakeStaleBlockedOwners>[1] & Parameters<typeof rewakeStalledReviewHolders>[1],
  now = new Date(),
) {
  if (now.getTime() - lastRewakeSweepAt < 60_000) return 0;
  lastRewakeSweepAt = now.getTime();
  const hours = blockedOwnerRewakeHours();
  const woken = await rewakeStaleBlockedOwners(db, wake, hours, now);
  return woken + await rewakeStalledReviewHolders(db, wake, hours, now);
}
