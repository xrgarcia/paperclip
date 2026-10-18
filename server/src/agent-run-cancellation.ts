import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { forbidden } from "./errors.js";

/**
 * slashbin (EM#625): a bridged seat that handed its own card on is settled
 * succeeded, not cancelled. Its confirmed reassignment stop still ends its
 * write authority and still releases its deferred input to the receiver, so
 * every guard that keys on a stop must recognize this one too.
 */
export function isAcknowledgedSelfHandoffStop(run: {
  status: string;
  resultJson?: Record<string, unknown> | null;
} | null | undefined): boolean {
  const result = run?.resultJson;
  return run?.status === "succeeded" && result?.selfHandoff === true &&
    result.reassignmentStopConfirmed === true &&
    typeof result.issueMutationStopId === "string" && result.issueMutationStopId.length > 0;
}

/** Stop revokes write authority before waiting for the executor to settle. */
export function agentRunWritesRevoked(run: {
  status: string;
  resultJson?: Record<string, unknown> | null;
} | null | undefined): boolean {
  const cancellation = run?.resultJson?.executionCancellation;
  return run?.status === "cancelled" || isAcknowledgedSelfHandoffStop(run) || Boolean(cancellation && typeof cancellation === "object"
    && "state" in cancellation && cancellation.state === "requested");
}

/** The caller must supply its write transaction, so Stop and commit serialize. */
export async function assertAgentRunWriteAllowed(tx: Db, companyId: string, actor: {
  agentId?: string | null;
  runId?: string | null;
  stopId?: string | null;
}) {
  if (!actor.agentId || !actor.runId) return;
  const [run] = await tx.select({ status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId),
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actor.agentId)))
    .for("share");
  const stoppedForThisMutation = (run?.status === "cancelled" || isAcknowledgedSelfHandoffStop(run)) && actor.stopId &&
    run.resultJson?.issueMutationStopId === actor.stopId;
  if (agentRunWritesRevoked(run) && !stoppedForThisMutation) {
    throw forbidden("This run was cancelled", { code: "agent_run_cancelled" });
  }
}
