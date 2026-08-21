-- Video title-slide editor + burn-in pipeline.
--
-- event_videos gains a JSONB slide document (admin-authored intro/outro
-- title cards, see src/lib/slides/types.ts) plus burn-status tracking
-- columns, mirroring the subtitle_jobs / read_along_jobs lifecycle. retreats
-- (the `events` table) gains organizer/credit/copyright fields used to
-- populate the default slide templates (src/lib/slides/defaults.ts).
-- NOTE: the events table is named "retreats" in the DB.

ALTER TABLE event_videos ADD COLUMN IF NOT EXISTS slides jsonb;
ALTER TABLE event_videos ADD COLUMN IF NOT EXISTS has_burned_slides boolean NOT NULL DEFAULT false;
ALTER TABLE event_videos ADD COLUMN IF NOT EXISTS burn_status text NOT NULL DEFAULT 'none';
ALTER TABLE event_videos ADD COLUMN IF NOT EXISTS burn_job_id text;
ALTER TABLE event_videos ADD COLUMN IF NOT EXISTS master_s3_key text;
ALTER TABLE event_videos ADD COLUMN IF NOT EXISTS burn_error text;
ALTER TABLE event_videos ADD COLUMN IF NOT EXISTS burned_intro_ms integer;

ALTER TABLE retreats ADD COLUMN IF NOT EXISTS organizer text;
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS credit_lines text[] NOT NULL DEFAULT '{}';
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS copyright_holder text;
