-- Per-user bookmarks at the event level (no track / no position).
-- Lets users mark whole events as favorites; resume-from-last-position
-- is already handled separately by user_progress / video_progress.
CREATE TABLE IF NOT EXISTS "event_bookmarks" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "event_id" integer NOT NULL REFERENCES "retreats"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "event_bookmarks_user_id_event_id_unique" UNIQUE("user_id", "event_id")
);

CREATE INDEX IF NOT EXISTS "event_bookmarks_user_id_idx"
  ON "event_bookmarks" ("user_id");
