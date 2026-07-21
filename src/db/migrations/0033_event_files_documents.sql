-- Event Documents: revive event_files as the generic document store.
-- The table may exist only via a setup script in some environments, so create
-- it defensively, then add the new Documents columns.
-- NOTE: the events table is named "retreats" in the DB (see 0031_event_videos.sql).

CREATE TABLE IF NOT EXISTS event_files (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES retreats(id) ON DELETE CASCADE,
  session_id integer REFERENCES sessions(id) ON DELETE SET NULL,
  original_filename text NOT NULL,
  s3_key text NOT NULL,
  file_type text NOT NULL,
  extension text NOT NULL,
  file_size_bytes bigint,
  language text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE event_files ADD COLUMN IF NOT EXISTS sensitive boolean NOT NULL DEFAULT false;
ALTER TABLE event_files ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE event_files ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS event_files_event_id_idx ON event_files(event_id);
