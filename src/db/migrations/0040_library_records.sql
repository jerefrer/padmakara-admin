-- The association's library metadata (Wix "libraryEvent" export), kept in the
-- database so an admin can fill an event's metadata from it.
--
-- `library_records` holds the uploaded CSV, one row per Wix event. Uploading a
-- newer export replaces every row. The searchable columns are the CSV values
-- as-is (matching normalises them in code, the dataset is ~1-2k rows); `raw`
-- keeps the full original row so nothing in the export is lost.
--
-- An event is linked to the record it was filled from through the existing
-- `retreats.wix_id` column. `retreats.library_snapshot` keeps the imported CSV
-- fields that have no column of their own (original designation, raw audience,
-- organisations, ...).
CREATE TABLE IF NOT EXISTS library_records (
  wix_id text PRIMARY KEY,
  event_code text,
  title text NOT NULL DEFAULT '',
  teacher_names text NOT NULL DEFAULT '',
  guest_name text NOT NULL DEFAULT '',
  organization text NOT NULL DEFAULT '',
  place text NOT NULL DEFAULT '',
  designation text NOT NULL DEFAULT '',
  date_range text NOT NULL DEFAULT '',
  start_date date,
  end_date date,
  raw jsonb NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS library_records_event_code_idx ON library_records (event_code);
CREATE INDEX IF NOT EXISTS library_records_start_date_idx ON library_records (start_date);

ALTER TABLE retreats
  ADD COLUMN IF NOT EXISTS library_snapshot jsonb;
