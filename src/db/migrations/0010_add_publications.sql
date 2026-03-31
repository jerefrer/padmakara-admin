CREATE TABLE "publications" (
	"id" serial PRIMARY KEY NOT NULL,
	"title_pt" text NOT NULL,
	"title_en" text,
	"subtitle" text,
	"description" text,
	"authors" text[] DEFAULT '{}' NOT NULL,
	"language" text DEFAULT 'pt' NOT NULL,
	"page_count" integer,
	"publication_date" date,
	"cover_image_s3_key" text,
	"pdf_s3_key" text NOT NULL,
	"file_size_bytes" bigint,
	"access_level" text DEFAULT 'public' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_publications" (
	"event_id" integer NOT NULL,
	"publication_id" integer NOT NULL,
	CONSTRAINT "event_publications_event_id_publication_id_pk" PRIMARY KEY("event_id","publication_id")
);
--> statement-breakpoint
ALTER TABLE "event_publications" ADD CONSTRAINT "event_publications_event_id_retreats_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_publications" ADD CONSTRAINT "event_publications_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;
