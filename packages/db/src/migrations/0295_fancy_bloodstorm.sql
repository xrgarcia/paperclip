CREATE TABLE "document_index_acks" (
	"document_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"acknowledged_revision_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "document_index_acks_document_id_environment_pk" PRIMARY KEY("document_id","environment"),
	CONSTRAINT "document_index_acks_environment_check" CHECK ("document_index_acks"."environment" in ('dev', 'prod'))
);
--> statement-breakpoint
ALTER TABLE "document_index_acks" ADD CONSTRAINT "document_index_acks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;