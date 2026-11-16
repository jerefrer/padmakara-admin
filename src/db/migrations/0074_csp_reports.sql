CREATE TABLE IF NOT EXISTS "csp_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"site" text NOT NULL,
	"directive" text NOT NULL,
	"blocked" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"line_number" integer,
	"column_number" integer,
	"disposition" text DEFAULT 'report' NOT NULL,
	"browser" text DEFAULT 'unknown' NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "csp_reports_unique_idx" ON "csp_reports" USING btree ("site","directive","blocked","source");