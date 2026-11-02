ALTER TABLE "event_videos" ADD COLUMN IF NOT EXISTS "session_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_videos" ADD CONSTRAINT "event_videos_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_videos_session_id_idx" ON "event_videos" USING btree ("session_id");
