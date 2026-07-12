CREATE TABLE IF NOT EXISTS session_videos (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  bunny_video_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  duration_seconds INTEGER,
  poster_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_videos_session_id_idx ON session_videos(session_id);
CREATE INDEX IF NOT EXISTS session_videos_bunny_video_id_idx ON session_videos(bunny_video_id);

-- Backfill any existing per-session video into the new table (no-op on a wiped DB).
INSERT INTO session_videos (session_id, bunny_video_id, position, duration_seconds, poster_url)
SELECT id, bunny_video_id, 0, video_duration_seconds, video_poster_url
FROM sessions
WHERE bunny_video_id IS NOT NULL;

ALTER TABLE sessions DROP COLUMN IF EXISTS bunny_video_id;
ALTER TABLE sessions DROP COLUMN IF EXISTS video_duration_seconds;
ALTER TABLE sessions DROP COLUMN IF EXISTS video_poster_url;
