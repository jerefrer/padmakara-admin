-- Schema drift cleanup: align the migration-built database with the Drizzle schema.
--
-- 1. Constraints created by hand-written SQL carry PostgreSQL default names
--    (*_fkey, *_key, *_pkey); the schema uses Drizzle names (*_fk, *_unique, *_pk).
--    Definitions are identical, only names differ. Each rename runs only if the old
--    name exists on that table and the new one does not, so it is safe on a database
--    where some (or all) of them already happened, and a no-op when re-run.
-- 2. users.stripe_customer_id (and its unique constraint) came from 0003 and is not in
--    the schema; nothing in src/ uses it. CHECK PROD FIRST that the column holds no data
--    you want to keep: dropping it is irreversible.
-- 3. The enum types file_action, file_category, log_level and migration_status (0004)
--    outlived their tables, which 0032 dropped.
--
-- Not touched on purpose: the serial sequences session_videos_id_seq and
-- session_subtitles_id_seq keep their old names (cosmetic, not a constraint).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('event_bookmarks', 'event_bookmarks_user_id_fkey', 'event_bookmarks_user_id_users_id_fk'),
      ('event_bookmarks', 'event_bookmarks_event_id_fkey', 'event_bookmarks_event_id_retreats_id_fk'),
      ('track_bookmarks', 'track_bookmarks_user_id_fkey', 'track_bookmarks_user_id_users_id_fk'),
      ('track_bookmarks', 'track_bookmarks_track_id_fkey', 'track_bookmarks_track_id_tracks_id_fk'),
      ('read_along_jobs', 'read_along_jobs_event_id_fkey', 'read_along_jobs_event_id_retreats_id_fk'),
      ('user_sync_versions', 'user_sync_versions_user_id_fkey', 'user_sync_versions_user_id_users_id_fk'),
      ('user_sync_versions', 'user_sync_versions_pkey', 'user_sync_versions_user_id_pk'),
      ('subtitle_jobs', 'subtitle_jobs_session_video_id_fkey', 'subtitle_jobs_video_id_event_videos_id_fk'),
      ('video_progress', 'video_progress_user_id_fkey', 'video_progress_user_id_users_id_fk'),
      ('video_progress', 'video_progress_video_id_fkey', 'video_progress_video_id_event_videos_id_fk'),
      ('video_subtitles', 'session_subtitles_session_video_id_fkey', 'video_subtitles_video_id_event_videos_id_fk'),
      ('video_subtitles', 'session_subtitles_pkey', 'video_subtitles_pkey'),
      ('payment_transactions', 'payment_transactions_user_id_fkey', 'payment_transactions_user_id_users_id_fk'),
      ('payment_transactions', 'payment_transactions_dedupe_key_key', 'payment_transactions_dedupe_key_unique'),
      ('event_videos', 'event_videos_event_id_fkey', 'event_videos_event_id_retreats_id_fk'),
      ('event_videos', 'session_videos_pkey', 'event_videos_pkey'),
      ('publications', 'publications_audience_id_fkey', 'publications_audience_id_audiences_id_fk'),
      ('retreat_organizers', 'retreat_organizers_retreat_id_fkey', 'retreat_organizers_retreat_id_retreats_id_fk'),
      ('retreat_organizers', 'retreat_organizers_organizer_id_fkey', 'retreat_organizers_organizer_id_organizers_id_fk'),
      ('retreat_organizers', 'retreat_organizers_pkey', 'retreat_organizers_retreat_id_organizer_id_pk'),
      ('organizers', 'organizers_name_key', 'organizers_name_unique'),
      ('organizers', 'organizers_abbreviation_key', 'organizers_abbreviation_unique')
    ) AS t(tbl, old_name, new_name)
  LOOP
    IF EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = to_regclass(format('public.%I', r.tbl)) AND conname = r.old_name)
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = to_regclass(format('public.%I', r.tbl)) AND conname = r.new_name)
    THEN
      EXECUTE format('ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_stripe_customer_id_unique";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "stripe_customer_id";
--> statement-breakpoint
DROP TYPE IF EXISTS "file_action";
--> statement-breakpoint
DROP TYPE IF EXISTS "file_category";
--> statement-breakpoint
DROP TYPE IF EXISTS "log_level";
--> statement-breakpoint
DROP TYPE IF EXISTS "migration_status";
