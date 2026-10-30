// Slashbin patch (EM#642): the publication sync drainer against a stubbed MCS sync route.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, documentIndexAcks, documentPublications, documents } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  publicationSyncDrainer,
  readDocumentSyncTarget,
  type DocumentSyncTarget,
} from "../slashbin/publication-sync-drainer.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

type Call = { url: string; authorization: string; body: { companyId: string; documentIds: string[] } };
type Reply = { status?: number; body: unknown };

describeEmbeddedPostgres("document index sync drainer", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-document-index-sync-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(documentIndexAcks);
    await db.delete(documentPublications);
    await db.delete(documents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function company() {
    const [row] = await db.insert(companies).values({
      name: "Sync Co",
      issuePrefix: `SYN${randomUUID().replace(/-/g, "").slice(0, 4)}`,
    }).returning();
    return row!;
  }

  async function publication(companyId: string, state: "draft" | "published" | "withdrawn", revisionId: string | null = null) {
    const [doc] = await db.insert(documents).values({ companyId, latestBody: "body" }).returning();
    await db.insert(documentPublications).values({
      documentId: doc!.id,
      companyId,
      state,
      publishedRevisionId: revisionId,
      publishedRevisionNumber: revisionId ? 1 : null,
    });
    return doc!.id;
  }

  const ack = (documentId: string, environment = "dev") =>
    db.select().from(documentIndexAcks)
      .where(and(eq(documentIndexAcks.documentId, documentId), eq(documentIndexAcks.environment, environment)))
      .then((rows) => rows[0] ?? null);

  function harness(companyId: string, replies: Array<Reply | (() => Promise<Reply>) | Error>) {
    const calls: Call[] = [];
    const target: DocumentSyncTarget = { baseUrl: "https://mcs.test/", token: "tok-secret", environment: "dev", companyId };
    const drainer = publicationSyncDrainer(db, {
      target: () => target,
      fetch: async (url, init) => {
        calls.push({
          url,
          authorization: init.headers.authorization!,
          body: JSON.parse(init.body),
        });
        const next = replies.shift();
        if (!next) throw new Error("unexpected call");
        if (next instanceof Error) throw next;
        const reply = typeof next === "function" ? await next() : next;
        return { ok: (reply.status ?? 200) < 300, status: reply.status ?? 200, json: async () => reply.body };
      },
    });
    return { drainer, calls };
  }

  const ok = (companyId: string, results: unknown[], environment = "dev") => ({
    body: { environment, companyId, status: "ok", results },
  });

  it("sends a pending publication, acks the indexed revision, and then stays quiet", async () => {
    const c = await company();
    const rev = randomUUID();
    const id = await publication(c.id, "published", rev);
    await publication(c.id, "draft");
    const { drainer, calls } = harness(c.id, [
      ok(c.id, [{ documentId: id, caseIdentifier: "X-1", key: "k", outcome: "updated", indexedRevisionId: rev, chunks: 2, error: null }]),
    ]);

    expect(await drainer.sweep()).toEqual({ called: true, acked: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://mcs.test/internal/document-sync");
    expect(calls[0]!.authorization).toBe("Bearer tok-secret");
    expect(calls[0]!.body).toEqual({ companyId: c.id, documentIds: [id] });
    const row = await ack(id);
    expect(row).toMatchObject({ acknowledgedRevisionId: rev, attemptCount: 0, lastError: null });
    expect(row!.acknowledgedAt).toBeInstanceOf(Date);

    // Nothing pending: no call, no change.
    expect(await drainer.sweep()).toEqual({ called: false, acked: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(await ack(id)).toEqual(row);
  });

  it("makes no call for drafts, or for a document published then withdrawn before any ack", async () => {
    const c = await company();
    await publication(c.id, "draft");
    await publication(c.id, "withdrawn", randomUUID());
    const { drainer, calls } = harness(c.id, []);
    expect(await drainer.sweep()).toEqual({ called: false, acked: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    expect(await db.select().from(documentIndexAcks)).toHaveLength(0);
  });

  it("never sends another company's documents", async () => {
    const c = await company();
    const other = await company();
    await publication(other.id, "published", randomUUID());
    const { drainer, calls } = harness(c.id, []);
    expect(await drainer.sweep()).toEqual({ called: false, acked: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });

  it("records a failed result, rising on each sweep, and acks nothing", async () => {
    const c = await company();
    const rev = randomUUID();
    const id = await publication(c.id, "published", rev);
    const failed = () => ok(c.id, [{ documentId: id, caseIdentifier: "X-1", key: "k", outcome: "failed", indexedRevisionId: null, chunks: 0, error: "embed blew up" }]);
    const { drainer } = harness(c.id, [failed(), failed()]);
    await drainer.sweep();
    await drainer.sweep();
    expect(await ack(id)).toMatchObject({ acknowledgedRevisionId: null, attemptCount: 2, lastError: "embed blew up", acknowledgedAt: null });
  });

  it("treats a 502, a transport error and a timeout as failed for every document, keeping a prior ack", async () => {
    const c = await company();
    const oldRev = randomUUID();
    const a = await publication(c.id, "published", randomUUID());
    const b = await publication(c.id, "published", randomUUID());
    await db.insert(documentIndexAcks).values({ documentId: a, environment: "dev", acknowledgedRevisionId: oldRev });
    const { drainer } = harness(c.id, [
      { status: 502, body: { status: "failed", reason: "unavailable", detail: "paperclip down" } },
      new Error("connect ECONNREFUSED"),
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    ]);
    await drainer.sweep();
    expect(await ack(a)).toMatchObject({ acknowledgedRevisionId: oldRev, attemptCount: 1 });
    expect((await ack(a))!.lastError).toContain("502 unavailable: paperclip down");
    await drainer.sweep();
    await drainer.sweep();
    expect(await ack(b)).toMatchObject({ acknowledgedRevisionId: null, attemptCount: 3 });
    expect((await ack(b))!.lastError).toContain("timeout");
  });

  it("sets the acknowledged revision to NULL on withdrawn", async () => {
    const c = await company();
    const rev = randomUUID();
    const id = await publication(c.id, "published", rev);
    await db.insert(documentIndexAcks).values({ documentId: id, environment: "dev", acknowledgedRevisionId: rev, attemptCount: 3, lastError: "old" });
    await db.update(documentPublications).set({ state: "withdrawn" }).where(eq(documentPublications.documentId, id));
    const { drainer, calls } = harness(c.id, [
      ok(c.id, [{ documentId: id, caseIdentifier: "X-1", key: "k", outcome: "withdrawn", indexedRevisionId: null, chunks: 0, error: null }]),
    ]);
    expect(await drainer.sweep()).toEqual({ called: true, acked: 1, failed: 0 });
    expect(calls[0]!.body.documentIds).toEqual([id]);
    expect(await ack(id)).toMatchObject({ acknowledgedRevisionId: null, attemptCount: 0, lastError: null });
    expect((await ack(id))!.acknowledgedAt).toBeInstanceOf(Date);
    // Withdrawn and acknowledged: no longer pending.
    expect((await drainer.sweep()).called).toBe(false);
  });

  it("leaves the ack behind when a publish lands during the call", async () => {
    const c = await company();
    const first = randomUUID();
    const second = randomUUID();
    const id = await publication(c.id, "published", first);
    const { drainer, calls } = harness(c.id, [
      async () => {
        await db.update(documentPublications).set({ publishedRevisionId: second }).where(eq(documentPublications.documentId, id));
        return ok(c.id, [{ documentId: id, caseIdentifier: "X-1", key: "k", outcome: "updated", indexedRevisionId: first, chunks: 1, error: null }]);
      },
      ok(c.id, [{ documentId: id, caseIdentifier: "X-1", key: "k", outcome: "updated", indexedRevisionId: second, chunks: 1, error: null }]),
    ]);
    expect(await drainer.sweep()).toEqual({ called: true, acked: 0, failed: 0 });
    expect(await ack(id)).toBeNull();
    expect(await drainer.sweep()).toEqual({ called: true, acked: 1, failed: 0 });
    expect(calls).toHaveLength(2);
    expect(await ack(id)).toMatchObject({ acknowledgedRevisionId: second });
  });

  it("acks nothing when the response environment differs from the label", async () => {
    const c = await company();
    const rev = randomUUID();
    const id = await publication(c.id, "published", rev);
    const { drainer } = harness(c.id, [
      ok(c.id, [{ documentId: id, caseIdentifier: "X-1", key: "k", outcome: "updated", indexedRevisionId: rev, chunks: 1, error: null }], "prod"),
    ]);
    expect(await drainer.sweep()).toEqual({ called: true, acked: 0, failed: 1 });
    const row = await ack(id);
    expect(row).toMatchObject({ acknowledgedRevisionId: null, attemptCount: 1 });
    expect(row!.lastError).toContain("environment prod, expected dev");
  });

  it("skips the sweep when configuration is absent", async () => {
    const c = await company();
    await publication(c.id, "published", randomUUID());
    let called = false;
    const drainer = publicationSyncDrainer(db, {
      target: () => readDocumentSyncTarget({}).target,
      fetch: async () => {
        called = true;
        throw new Error("must not be called");
      },
    });
    expect(await drainer.sweep()).toEqual({ called: false, acked: 0, failed: 0 });
    expect(called).toBe(false);
    expect(await db.select().from(documentIndexAcks)).toHaveLength(0);
  });
});

describe("readDocumentSyncTarget", () => {
  const full = {
    DOCUMENT_SYNC_BASE_URL: "https://mcs.test",
    DOCUMENT_SYNC_TOKEN: "t",
    DOCUMENT_SYNC_ENVIRONMENT: "prod",
    DOCUMENT_SYNC_COMPANY_ID: "2ead795c-c91d-460b-bc37-ff0ae474b298",
  };

  it("reads a complete configuration", () => {
    expect(readDocumentSyncTarget(full).target).toMatchObject({ environment: "prod", token: "t" });
  });

  it("names what is missing or invalid without echoing the token", () => {
    expect(readDocumentSyncTarget({ ...full, DOCUMENT_SYNC_TOKEN: "" })).toMatchObject({ target: null });
    expect(readDocumentSyncTarget({ ...full, DOCUMENT_SYNC_TOKEN: "" }).reason).toContain("DOCUMENT_SYNC_TOKEN");
    expect(readDocumentSyncTarget({ ...full, DOCUMENT_SYNC_ENVIRONMENT: "staging" }).target).toBeNull();
    expect(readDocumentSyncTarget({ ...full, DOCUMENT_SYNC_COMPANY_ID: "nope" }).target).toBeNull();
    expect(readDocumentSyncTarget({ ...full, DOCUMENT_SYNC_BASE_URL: "nope" }).target).toBeNull();
  });
});
