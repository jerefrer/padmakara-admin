CREATE TABLE IF NOT EXISTS "reader_page_bookmarks" (
	"user_id" integer NOT NULL,
	"document_type" text NOT NULL,
	"document_id" integer NOT NULL,
	"page" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_page_bookmarks_user_id_document_type_document_id_page_pk" PRIMARY KEY("user_id","document_type","document_id","page"),
	CONSTRAINT "reader_page_bookmarks_document_type_check" CHECK ("reader_page_bookmarks"."document_type" IN ('publication', 'transcript')),
	CONSTRAINT "reader_page_bookmarks_page_check" CHECK ("reader_page_bookmarks"."page" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reader_positions" (
	"user_id" integer NOT NULL,
	"document_type" text NOT NULL,
	"document_id" integer NOT NULL,
	"page" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_positions_user_id_document_type_document_id_pk" PRIMARY KEY("user_id","document_type","document_id"),
	CONSTRAINT "reader_positions_document_type_check" CHECK ("reader_positions"."document_type" IN ('publication', 'transcript')),
	CONSTRAINT "reader_positions_page_check" CHECK ("reader_positions"."page" >= 1)
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reader_page_bookmarks" ADD CONSTRAINT "reader_page_bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reader_positions" ADD CONSTRAINT "reader_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
