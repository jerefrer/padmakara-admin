-- Move subtitles from per-session to per-session_video.

ALTER TABLE session_subtitles ADD COLUMN IF NOT EXISTS session_video_id INTEGER REFERENCES session_videos(id) ON DELETE CASCADE;
ALTER TABLE subtitle_jobs ADD COLUMN IF NOT EXISTS session_video_id INTEGER REFERENCES session_videos(id) ON DELETE CASCADE;

-- Backfill: attribute existing rows to the session's primary (position 0) video.
-- No-op on a wiped DB (no rows to backfill).
UPDATE session_subtitles ss
SET session_video_id = (
  SELECT sv.id FROM session_videos sv
  WHERE sv.session_id = ss.session_id
  ORDER BY sv.position ASC
  LIMIT 1
)
WHERE session_video_id IS NULL;

UPDATE subtitle_jobs sj
SET session_video_id = (
  SELECT sv.id FROM session_videos sv
  WHERE sv.session_id = sj.session_id
  ORDER BY sv.position ASC
  LIMIT 1
)
WHERE session_video_id IS NULL;

-- Drop the OLD unique constraint on (session_id, language). Confirmed live name via
-- `psql "$DATABASE_URL" -c "SELECT conname FROM pg_constraint WHERE conrelid='session_subtitles'::regclass AND contype='u';"`
-- to be session_subtitles_session_id_language_unique (matches the Drizzle default naming
-- convention). Belt-and-suspenders: also look it up by columns in case the name differs
-- in another environment (e.g. prod, if it was created differently).
ALTER TABLE session_subtitles DROP CONSTRAINT IF EXISTS session_subtitles_session_id_language_unique;

DO $$
DECLARE
  cname text;
  target_attnums smallint[];
BEGIN
  SELECT array_agg(attnum ORDER BY attnum) INTO target_attnums
  FROM pg_attribute
  WHERE attrelid = 'session_subtitles'::regclass
    AND attname IN ('session_id', 'language');

  SELECT con.conname INTO cname
  FROM pg_constraint con
  WHERE con.conrelid = 'session_subtitles'::regclass
    AND con.contype = 'u'
    AND (SELECT array_agg(k ORDER BY k) FROM unnest(con.conkey) AS k) = target_attnums;

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE session_subtitles DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- New unique constraint keyed on session_video_id instead of session_id.
ALTER TABLE session_subtitles ADD CONSTRAINT session_subtitles_session_video_id_language_unique UNIQUE (session_video_id, language);
