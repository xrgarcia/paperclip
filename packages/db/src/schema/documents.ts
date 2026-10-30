import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, jsonb, check } from "drizzle-orm/pg-core";
import type { SourceTrustMetadata } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title"),
    format: text("format").notNull().default("markdown"),
    latestBody: text("latest_body").notNull(),
    latestRevisionId: uuid("latest_revision_id"),
    latestRevisionNumber: integer("latest_revision_number").notNull().default(1),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedByAgentId: uuid("locked_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    lockedByUserId: text("locked_by_user_id"),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUpdatedIdx: index("documents_company_updated_idx").on(table.companyId, table.updatedAt),
    companyCreatedIdx: index("documents_company_created_idx").on(table.companyId, table.createdAt),
    titleSearchIdx: index("documents_title_search_idx").using("gin", table.title.op("gin_trgm_ops")),
    bodySearchIdx: index("documents_latest_body_search_idx").using("gin", table.latestBody.op("gin_trgm_ops")),
  }),
);

// Slashbin patch (EM#642): which revision of a Case document is published. One row per
// document, written only by server/src/slashbin/document-publications.ts.
export const documentPublications = pgTable(
  "document_publications",
  {
    documentId: uuid("document_id").primaryKey().references(() => documents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("draft"),
    publishedRevisionId: uuid("published_revision_id"),
    publishedRevisionNumber: integer("published_revision_number"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStateIdx: index("document_publications_company_state_idx").on(table.companyId, table.state),
    stateCheck: check("document_publications_state_check", sql`${table.state} in ('draft', 'published', 'withdrawn')`),
  }),
);
