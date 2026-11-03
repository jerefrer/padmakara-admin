CREATE TABLE IF NOT EXISTS "search_queries" (
	"id" serial PRIMARY KEY NOT NULL,
	"query" text NOT NULL,
	"result_count" integer NOT NULL,
	"language" varchar(8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_queries_created_at_idx" ON "search_queries" USING btree ("created_at");