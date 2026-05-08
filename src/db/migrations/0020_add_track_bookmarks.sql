-- Whole-track bookmarks (no time position). Toggled from the player toolbar.
-- The older `bookmarks` table (track + positionSeconds) stays untouched —
-- this one captures "I want to find this track again," not "remember this
-- moment in this track."
CREATE TABLE IF NOT EXISTS "track_bookmarks" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "track_id" integer NOT NULL REFERENCES "tracks"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "track_bookmarks_user_id_track_id_unique" UNIQUE("user_id", "track_id")
);

CREATE INDEX IF NOT EXISTS "track_bookmarks_user_id_idx"
  ON "track_bookmarks" ("user_id");
