// Slashbin patch (EM#642): which revision of a Case document is published.
// Every edit makes `documents.latest_body` current at once, so MCP and RAG readers
// have nothing stable to read. PublicationOwner is the only writer of
// `document_publications`: one row per Case document, `draft` from the moment the
// document exists (the PUT create transaction inserts it beside `case_documents`,
// and the migration backfilled one per existing row), `published` with a captured
// revision, `withdrawn` with that revision kept as history.
//
// Callers hold lockCaseDocumentKey and have passed the protected-Case gate
// (routes/cases.ts). A later edit or restore never touches this table, so the
// published revision stays put until an editor publishes again. Nothing is deleted.
import { and, asc, eq } from "drizzle-orm";
import {
  caseDocuments,
  cases,
  documentPublications,
  documentRevisions,
  type Db,
} from "@paperclipai/db";
import { conflict } from "../errors.js";

type PublicationDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type PublicationState = "draft" | "published" | "withdrawn";

export type PublicationMove = {
  documentId: string;
  state: "published" | "withdrawn";
  revisionId: string;
  revisionNumber: number;
  publishedAt: Date;
  withdrawnAt: Date | null;
};

type DocumentRef = { id: string; companyId: string; latestRevisionId: string | null; latestRevisionNumber: number };

async function loadRow(db: PublicationDb, documentId: string) {
  const row = await db
    .select()
    .from(documentPublications)
    .where(eq(documentPublications.documentId, documentId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  // Creation and the migration backfill give every Case document a row; a missing
  // one is a defect to surface, never a state to repair here.
  if (!row) throw new Error(`document ${documentId} has no publication row`);
  return row;
}

function move(row: typeof documentPublications.$inferSelect, state: "published" | "withdrawn"): PublicationMove {
  return {
    documentId: row.documentId,
    state,
    revisionId: row.publishedRevisionId!,
    revisionNumber: row.publishedRevisionNumber!,
    publishedAt: row.publishedAt!,
    withdrawnAt: row.withdrawnAt,
  };
}

export const PublicationOwner = {
  /** The draft row of a new document; call in the transaction that inserts `case_documents`. */
  async createDraft(tx: PublicationDb, input: { documentId: string; companyId: string; now?: Date }) {
    const now = input.now ?? new Date();
    await tx.insert(documentPublications).values({
      documentId: input.documentId,
      companyId: input.companyId,
      state: "draft",
      createdAt: now,
      updatedAt: now,
    });
  },

  /**
   * Publishes the document's latest revision. `baseRevisionId` must be that
   * revision, so an edit that landed after the editor read it cannot be published
   * unseen. Publishing the revision that is already published changes nothing.
   */
  async publish(
    tx: PublicationDb,
    input: { document: DocumentRef; baseRevisionId: string; publishedBy: string },
  ): Promise<PublicationMove> {
    const { document } = input;
    if (input.baseRevisionId !== document.latestRevisionId || !document.latestRevisionId) {
      throw conflict("Case document was updated by someone else", {
        code: "stale_base_revision",
        latestRevisionId: document.latestRevisionId,
        latestRevisionNumber: document.latestRevisionNumber,
      });
    }
    const row = await loadRow(tx, document.id);
    if (row.state === "published" && row.publishedRevisionId === document.latestRevisionId) return move(row, "published");
    const now = new Date();
    const [updated] = await tx.update(documentPublications).set({
      state: "published",
      publishedRevisionId: document.latestRevisionId,
      publishedRevisionNumber: document.latestRevisionNumber,
      publishedAt: now,
      publishedBy: input.publishedBy,
      withdrawnAt: null,
      updatedAt: now,
    }).where(eq(documentPublications.documentId, document.id)).returning();
    return move(updated!, "published");
  },

  /** Takes a published document out of the published set; the revision it held stays as history. */
  async withdraw(tx: PublicationDb, input: { document: DocumentRef }): Promise<PublicationMove> {
    const row = await loadRow(tx, input.document.id);
    if (row.state === "withdrawn") return move(row, "withdrawn");
    if (row.state !== "published") {
      throw conflict("Case document is not published", { code: "not_published", state: row.state });
    }
    const now = new Date();
    const [updated] = await tx.update(documentPublications).set({
      state: "withdrawn",
      withdrawnAt: now,
      updatedAt: now,
    }).where(eq(documentPublications.documentId, input.document.id)).returning();
    return move(updated!, "withdrawn");
  },

  /** Every published document of a company, as published: the captured revision's body, never the latest. */
  async listPublished(db: PublicationDb, companyId: string) {
    const rows = await db
      .select({
        documentId: documentPublications.documentId,
        caseId: cases.id,
        caseIdentifier: cases.identifier,
        key: caseDocuments.key,
        title: documentRevisions.title,
        revisionId: documentRevisions.id,
        revisionNumber: documentRevisions.revisionNumber,
        publishedAt: documentPublications.publishedAt,
        body: documentRevisions.body,
      })
      .from(documentPublications)
      .innerJoin(caseDocuments, eq(caseDocuments.documentId, documentPublications.documentId))
      .innerJoin(cases, eq(cases.id, caseDocuments.caseId))
      .innerJoin(documentRevisions, and(
        eq(documentRevisions.id, documentPublications.publishedRevisionId),
        eq(documentRevisions.documentId, documentPublications.documentId),
      ))
      .where(and(eq(documentPublications.companyId, companyId), eq(documentPublications.state, "published")))
      .orderBy(asc(cases.identifier), asc(caseDocuments.key));
    // Order by code point, not database collation, so the order is the same everywhere.
    const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return rows.sort((a, b) => byCodePoint(a.caseIdentifier, b.caseIdentifier) || byCodePoint(a.key, b.key));
  },
};
