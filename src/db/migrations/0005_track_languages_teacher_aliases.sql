-- Add aliases column to teachers table
ALTER TABLE "teachers" ADD COLUMN "aliases" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
-- Add languages array and original_language columns to tracks table
ALTER TABLE "tracks" ADD COLUMN "languages" text[] DEFAULT '{en}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "original_language" text DEFAULT 'en' NOT NULL;
--> statement-breakpoint
-- Migrate existing track data: populate languages and original_language from old language column
-- original_language = the track's own primary language (same as old language column)
-- isTranslation flag tells you whether it's a translation
UPDATE "tracks" SET
  "languages" = ARRAY["language"],
  "original_language" = "language";
--> statement-breakpoint
-- Drop the old unique constraint on (session_id, track_number, language)
ALTER TABLE "tracks" DROP CONSTRAINT IF EXISTS "tracks_session_id_track_number_language_unique";
--> statement-breakpoint
-- Add new unique constraint on (session_id, track_number, original_language)
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_session_id_track_number_original_language_unique" UNIQUE("session_id", "track_number", "original_language");
--> statement-breakpoint
-- Drop the old language column (replaced by languages array + original_language)
ALTER TABLE "tracks" DROP COLUMN "language";
