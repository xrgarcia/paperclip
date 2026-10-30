CREATE TABLE "document_publications" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"published_revision_id" uuid,
	"published_revision_number" integer,
	"published_at" timestamp with time zone,
	"published_by" text,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_publications_state_check" CHECK ("document_publications"."state" in ('draft', 'published', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "document_publications" ADD CONSTRAINT "document_publications_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_publications" ADD CONSTRAINT "document_publications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_publications_company_state_idx" ON "document_publications" USING btree ("company_id","state");
--> statement-breakpoint
INSERT INTO "document_publications" ("document_id", "company_id", "state")
SELECT "document_id", "company_id", 'draft' FROM "case_documents"
ON CONFLICT ("document_id") DO NOTHING;
