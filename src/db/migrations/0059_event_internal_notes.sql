CREATE TABLE IF NOT EXISTS "event_internal_notes" (
	"event_id" integer PRIMARY KEY NOT NULL,
	"notes" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "event_internal_notes" ADD CONSTRAINT "event_internal_notes_event_id_retreats_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;