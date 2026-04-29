-- Cross-device watched-position storage for session videos.
-- Schema disjoint from user_progress (which is keyed by track_id) — videos
-- are session-scoped, so we key by session_id.
CREATE TABLE IF NOT EXISTS "video_progress" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id" integer NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "position_seconds" integer NOT NULL DEFAULT 0,
  "duration_seconds" integer,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "video_progress_user_id_session_id_unique" UNIQUE("user_id", "session_id")
);
