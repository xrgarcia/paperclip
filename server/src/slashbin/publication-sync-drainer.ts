// Slashbin patch (EM#642): level-triggered sweep that keeps the RAG index (MCS)
// reconciled to the published Case documents. Publishing does not refresh the index,
// so each sweep finds every document whose published state is ahead of the index's last
// acknowledgement, asks MCS to reconcile those ids in one call, and records each result
// in `document_index_acks`. Pending is computed from the two tables, never stored, so a
// failed or lost call retries on the next sweep. PublicationSyncDrainer is the only
// writer of `document_index_acks` and never writes `document_publications`.
//
// An ack means "synced", not "verified". A 200 alone acks nothing: only the per-document
// result does, and only while the publication still names the revision the index holds.
import { and, eq, sql } from "drizzle-orm";
import { documentIndexAcks, documentPublications, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export const DOCUMENT_SYNC_BASE_URL_ENV = "DOCUMENT_SYNC_BASE_URL";
export const DOCUMENT_SYNC_TOKEN_ENV = "DOCUMENT_SYNC_TOKEN";
export const DOCUMENT_SYNC_ENVIRONMENT_ENV = "DOCUMENT_SYNC_ENVIRONMENT";
export const DOCUMENT_SYNC_COMPANY_ID_ENV = "DOCUMENT_SYNC_COMPANY_ID";

/** The sync route accepts at most this many ids per call. */
const MAX_IDS_PER_CALL = 500;
const CALL_TIMEOUT_MS = 30_000;
const MAX_ERROR_LENGTH = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DocumentSyncTarget = {
  baseUrl: string;
  token: string;
  environment: "dev" | "prod";
  companyId: string;
};

export type SyncResult = {
  documentId: string;
  outcome: "updated" | "unchanged" | "withdrawn" | "failed";
  indexedRevisionId: string | null;
  error: string | null;
};

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type SyncDrainerOptions = {
  /** Defaults to reading the environment on every sweep. */
  target?: () => DocumentSyncTarget | null;
  fetch?: FetchLike;
  now?: () => Date;
};

type Pending = { documentId: string; publishedRevisionId: string | null; state: string };

/** Reads the target from the server environment; null (and one log line) when it is absent or invalid. */
export function readDocumentSyncTarget(env: NodeJS.ProcessEnv = process.env): { target: DocumentSyncTarget | null; reason: string | null } {
  const baseUrl = env[DOCUMENT_SYNC_BASE_URL_ENV]?.trim();
  const token = env[DOCUMENT_SYNC_TOKEN_ENV]?.trim();
  const environment = env[DOCUMENT_SYNC_ENVIRONMENT_ENV]?.trim();
  const companyId = env[DOCUMENT_SYNC_COMPANY_ID_ENV]?.trim();
  const missing = [
    [DOCUMENT_SYNC_BASE_URL_ENV, baseUrl],
    [DOCUMENT_SYNC_TOKEN_ENV, token],
    [DOCUMENT_SYNC_ENVIRONMENT_ENV, environment],
    [DOCUMENT_SYNC_COMPANY_ID_ENV, companyId],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) return { target: null, reason: `not configured, missing ${missing.join(", ")}` };
  if (environment !== "dev" && environment !== "prod") {
    return { target: null, reason: `${DOCUMENT_SYNC_ENVIRONMENT_ENV} must be dev or prod` };
  }
  if (!UUID.test(companyId!)) return { target: null, reason: `${DOCUMENT_SYNC_COMPANY_ID_ENV} must be a uuid` };
  try {
    new URL(baseUrl!);
  } catch {
    return { target: null, reason: `${DOCUMENT_SYNC_BASE_URL_ENV} is not a URL` };
  }
  return { target: { baseUrl: baseUrl!, token: token!, environment, companyId: companyId!.toLowerCase() }, reason: null };
}

function errorText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.slice(0, MAX_ERROR_LENGTH);
}

export function publicationSyncDrainer(db: Db, options: SyncDrainerOptions = {}) {
  const now = options.now ?? (() => new Date());
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  let loggedSkip: string | null = null;

  function resolveTarget(): DocumentSyncTarget | null {
    if (options.target) return options.target();
    const { target, reason } = readDocumentSyncTarget();
    if (!target && reason !== loggedSkip) {
      loggedSkip = reason;
      logger.info({ reason }, "document index sync skipped");
    }
    return target;
  }

  // Published and ahead of the ack, or withdrawn while the ack still names a revision.
  // A draft never matches, and a document published then withdrawn before any ack is not pending.
  async function pendingDocuments(target: DocumentSyncTarget): Promise<Pending[]> {
    const rows = await db
      .select({
        documentId: documentPublications.documentId,
        state: documentPublications.state,
        publishedRevisionId: documentPublications.publishedRevisionId,
      })
      .from(documentPublications)
      .leftJoin(
        documentIndexAcks,
        and(
          eq(documentIndexAcks.documentId, documentPublications.documentId),
          eq(documentIndexAcks.environment, target.environment),
        ),
      )
      .where(
        and(
          eq(documentPublications.companyId, target.companyId),
          sql`((${documentPublications.state} = 'published'
              and ${documentPublications.publishedRevisionId} is distinct from ${documentIndexAcks.acknowledgedRevisionId})
            or (${documentPublications.state} = 'withdrawn' and ${documentIndexAcks.acknowledgedRevisionId} is not null))`,
        ),
      )
      .orderBy(documentPublications.documentId);
    return rows;
  }

  async function recordFailure(target: DocumentSyncTarget, documentId: string, error: string) {
    const at = now();
    await db
      .insert(documentIndexAcks)
      .values({ documentId, environment: target.environment, attemptCount: 1, lastError: error, lastAttemptAt: at })
      .onConflictDoUpdate({
        target: [documentIndexAcks.documentId, documentIndexAcks.environment],
        set: {
          attemptCount: sql`${documentIndexAcks.attemptCount} + 1`,
          lastError: error,
          lastAttemptAt: at,
        },
      });
  }

  // The ack records the index state MCS reported (the indexed revision, or NULL once
  // withdrawn), whatever the publication row says now. Sweeps are single-flight, so no
  // older response can overwrite a newer one. If the publication moved during the call,
  // the pending predicate (published and revision differs from the ack, or withdrawn
  // and the ack names a revision) re-drives the document on the next sweep.
  async function recordSuccess(
    target: DocumentSyncTarget,
    result: { documentId: string; outcome: SyncResult["outcome"]; indexedRevisionId: string | null },
  ): Promise<boolean> {
    const at = now();
    const acknowledgedRevisionId = result.outcome === "withdrawn" ? null : result.indexedRevisionId;
    return db.transaction(async (tx) => {
      await tx
        .insert(documentIndexAcks)
        .values({
          documentId: result.documentId,
          environment: target.environment,
          acknowledgedRevisionId,
          attemptCount: 0,
          lastError: null,
          lastAttemptAt: at,
          acknowledgedAt: at,
        })
        .onConflictDoUpdate({
          target: [documentIndexAcks.documentId, documentIndexAcks.environment],
          set: { acknowledgedRevisionId, attemptCount: 0, lastError: null, lastAttemptAt: at, acknowledgedAt: at },
        });
      return true;
    });
  }

  async function callSync(target: DocumentSyncTarget, documentIds: string[]): Promise<
    { kind: "results"; results: SyncResult[]; complete: boolean } | { kind: "error"; error: string }
  > {
    try {
      const response = await doFetch(`${target.baseUrl.replace(/\/+$/, "")}/internal/document-sync`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
        body: JSON.stringify({ companyId: target.companyId, documentIds }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        const detail = typeof body?.detail === "string" ? `: ${body.detail}` : "";
        const reason = typeof body?.reason === "string" ? ` ${body.reason}` : "";
        return { kind: "error", error: errorText(`document sync returned ${response.status}${reason}${detail}`) };
      }
      if (!body || typeof body !== "object" || !Array.isArray(body.results)) {
        return { kind: "error", error: "document sync returned a malformed body" };
      }
      if (body.environment !== target.environment) {
        return {
          kind: "error",
          error: errorText(`document sync answered for environment ${String(body.environment)}, expected ${target.environment}`),
        };
      }
      if (typeof body.companyId === "string" && body.companyId.toLowerCase() !== target.companyId) {
        return { kind: "error", error: "document sync answered for a different company" };
      }
      const results: SyncResult[] = [];
      for (const raw of body.results as Array<Record<string, unknown>>) {
        if (!raw || typeof raw.documentId !== "string") continue;
        const outcome = raw.outcome;
        results.push({
          documentId: raw.documentId.toLowerCase(),
          outcome: outcome === "updated" || outcome === "unchanged" || outcome === "withdrawn" ? outcome : "failed",
          indexedRevisionId: typeof raw.indexedRevisionId === "string" ? raw.indexedRevisionId : null,
          error: typeof raw.error === "string" ? raw.error : null,
        });
      }
      return { kind: "results", results, complete: body.status === "ok" || body.status === "partial" };
    } catch (err) {
      return { kind: "error", error: errorText(err) };
    }
  }

  /** One sweep. Returns how many documents were acked and how many failed. */
  async function sweep(): Promise<{ called: boolean; acked: number; failed: number }> {
    const target = resolveTarget();
    if (!target) return { called: false, acked: 0, failed: 0 };
    const pending = await pendingDocuments(target);
    if (pending.length === 0) return { called: false, acked: 0, failed: 0 };

    let acked = 0;
    let failed = 0;
    for (let i = 0; i < pending.length; i += MAX_IDS_PER_CALL) {
      const batch = pending.slice(i, i + MAX_IDS_PER_CALL);
      const ids = batch.map((p) => p.documentId);
      const reply = await callSync(target, ids);
      if (reply.kind === "error") {
        for (const id of ids) await recordFailure(target, id, reply.error);
        failed += ids.length;
        continue;
      }
      const state = new Map(batch.map((p) => [p.documentId, p.state]));
      const byId = new Map(reply.results.map((r) => [r.documentId, r]));
      for (const id of ids) {
        const result = byId.get(id);
        if (!result && reply.complete && state.get(id) === "withdrawn") {
          // The route answered ok/partial and lists no entry for a withdrawn id: it is
          // already absent from the index (a lost earlier response), so the ack clears.
          await recordSuccess(target, { documentId: id, outcome: "withdrawn", indexedRevisionId: null });
          acked += 1;
        } else if (!result) {
          await recordFailure(target, id, "document sync returned no result for this document");
          failed += 1;
        } else if (result.outcome === "failed") {
          await recordFailure(target, id, result.error ?? "document sync reported failure");
          failed += 1;
        } else if (result.outcome !== "withdrawn" && !result.indexedRevisionId) {
          await recordFailure(target, id, "document sync reported no indexed revision");
          failed += 1;
        } else if (await recordSuccess(target, result)) {
          acked += 1;
        }
      }
    }
    logger.info({ pending: pending.length, acked, failed }, "document index sync sweep");
    return { called: true, acked, failed };
  }

  return { sweep };
}

export type PublicationSyncDrainer = ReturnType<typeof publicationSyncDrainer>;
