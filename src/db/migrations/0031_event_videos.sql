-- Decouple videos from sessions: videos now belong directly to the event.
--   session_videos  → event_videos  (+ event_id, title_en/title_pt, video_date)
--   video_progress    re-keyed (user_id, session_id) → (user_id, video_id)
--   session_subtitles → video_subtitles (video_id only)
--   subtitle_jobs     keyed by video_id only
-- NOTE: the events table is named "retreats" in the DB.

-- ── 1. session_videos → event_videos ─────────────────────────────────────
ALTER TABLE IF EXISTS session_videos RENAME TO event_videos;

ALTER TABLE event_videos ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES retreats(id) ON DELETE CASCADE;
ALTER TABLE event_videos ADD COLUMN IF NOT EXISTS title_en TEXT;
ALTER TABLE event_videos ADD COLUMN IF NOT EXISTS title_pt TEXT;
ALTER TABLE event_videos ADD COLUMN IF NOT EXISTS video_date DATE;

-- Backfill event linkage + date from the old parent session.
UPDATE event_videos ev
SET event_id = s.retreat_id,
    video_date = s.session_date
FROM sessions s
WHERE ev.session_id = s.id
  AND ev.event_id IS NULL;

-- Backfill titles: keep any manual title, else derive from the session
-- (session title or time-period label, plus a Part suffix when the session
-- carried several videos).
UPDATE event_videos ev
SET title_en = COALESCE(
      ev.title,
      NULLIF(trim(concat(
        COALESCE(NULLIF(s.title_en, ''),
          CASE s.time_period
            WHEN 'morning' THEN 'Morning'
            WHEN 'afternoon' THEN 'Afternoon'
            WHEN 'evening' THEN 'Evening'
            ELSE ''
          END),
        CASE WHEN cnt.n > 1 THEN ' — Part ' || (ev.position + 1)::text ELSE '' END
      )), '')
    ),
    title_pt = NULLIF(trim(concat(
        COALESCE(NULLIF(s.title_pt, ''),
          CASE s.time_period
            WHEN 'morning' THEN 'Manhã'
            WHEN 'afternoon' THEN 'Tarde'
            WHEN 'evening' THEN 'Noite'
            ELSE ''
          END),
        CASE WHEN cnt.n > 1 THEN ' — Parte ' || (ev.position + 1)::text ELSE '' END
      )), '')
FROM sessions s,
     (SELECT session_id, count(*) AS n FROM event_videos GROUP BY session_id) cnt
WHERE ev.session_id = s.id
  AND cnt.session_id = ev.session_id
  AND ev.title_en IS NULL;

-- Event-wide playback order: session date, then session order, then old
-- within-session position (preserves each session's internal video order).
WITH ranked AS (
  SELECT ev.id,
         ROW_NUMBER() OVER (
           PARTITION BY ev.event_id
           ORDER BY s.session_date NULLS LAST, s.session_number, ev.position, ev.id
         ) - 1 AS new_pos
  FROM event_videos ev
  JOIN sessions s ON s.id = ev.session_id
)
UPDATE event_videos ev
SET position = r.new_pos
FROM ranked r
WHERE ev.id = r.id;

-- ── 2. video_progress: (user, session) → (user, video) ───────────────────
-- Must run while event_videos.session_id still exists.
ALTER TABLE video_progress ADD COLUMN IF NOT EXISTS video_id INTEGER REFERENCES event_videos(id) ON DELETE CASCADE;

-- Attribute each row to the session's first video. Under the old model all
-- of a session's videos shared one resume slot, so the first video is the
-- only defensible owner.
UPDATE video_progress vp
SET video_id = (
  SELECT ev.id FROM event_videos ev
  WHERE ev.session_id = vp.session_id
  ORDER BY ev.position ASC, ev.id ASC
  LIMIT 1
)
WHERE vp.video_id IS NULL;

DELETE FROM video_progress WHERE video_id IS NULL;
ALTER TABLE video_progress ALTER COLUMN video_id SET NOT NULL;
ALTER TABLE video_progress ADD CONSTRAINT video_progress_user_id_video_id_unique UNIQUE (user_id, video_id);
-- Dropping the column also drops the old (user_id, session_id) unique constraint.
ALTER TABLE video_progress DROP COLUMN IF EXISTS session_id;

-- ── 3. finalize event_videos ─────────────────────────────────────────────
DELETE FROM event_videos WHERE event_id IS NULL;
ALTER TABLE event_videos ALTER COLUMN event_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS event_videos_event_id_idx ON event_videos(event_id);
ALTER INDEX IF EXISTS session_videos_bunny_video_id_idx RENAME TO event_videos_bunny_video_id_idx;
ALTER TABLE event_videos DROP COLUMN IF EXISTS title;
ALTER TABLE event_videos DROP COLUMN IF EXISTS session_id;

-- ── 4. session_subtitles → video_subtitles ───────────────────────────────
ALTER TABLE IF EXISTS session_subtitles RENAME TO video_subtitles;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'video_subtitles' AND column_name = 'session_video_id'
  ) THEN
    ALTER TABLE video_subtitles RENAME COLUMN session_video_id TO video_id;
  END IF;
END $$;
DELETE FROM video_subtitles WHERE video_id IS NULL;
ALTER TABLE video_subtitles ALTER COLUMN video_id SET NOT NULL;
ALTER TABLE video_subtitles DROP COLUMN IF EXISTS session_id;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'session_subtitles_session_video_id_language_unique'
  ) THEN
    ALTER TABLE video_subtitles RENAME CONSTRAINT
      session_subtitles_session_video_id_language_unique TO video_subtitles_video_id_language_unique;
  END IF;
END $$;

-- ── 5. subtitle_jobs ─────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subtitle_jobs' AND column_name = 'session_video_id'
  ) THEN
    ALTER TABLE subtitle_jobs RENAME COLUMN session_video_id TO video_id;
  END IF;
END $$;
DELETE FROM subtitle_jobs WHERE video_id IS NULL;
ALTER TABLE subtitle_jobs ALTER COLUMN video_id SET NOT NULL;
ALTER TABLE subtitle_jobs DROP COLUMN IF EXISTS session_id;
