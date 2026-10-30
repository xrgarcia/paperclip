import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, primaryKey, check } from "drizzle-orm/pg-core";
import { documents } from "./documents.js";

// Slashbin patch (EM#642): the RAG index's last acknowledgement per document and
// environment. Written only by server/src/slashbin/publication-sync-drainer.ts; pending
// is computed from document_publications, never stored.
export const documentIndexAcks = pgTable(
  "document_index_acks",
  {
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    environment: text("environment").notNull(),
    acknowledgedRevisionId: uuid("acknowledged_revision_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.documentId, table.environment] }),
    environmentCheck: check("document_index_acks_environment_check", sql`${table.environment} in ('dev', 'prod')`),
  }),
);
