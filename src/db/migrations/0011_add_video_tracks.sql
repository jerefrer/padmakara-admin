-- Add video support to tracks table
-- Tracks can now be either audio (default, served from S3) or video (served from Bunny Stream)
-- A session may contain a mix of audio and video tracks ordered by track_number.
ALTER TABLE "tracks" ADD COLUMN "media_type" text NOT NULL DEFAULT 'audio';
--> statement-breakpoint
-- Bunny Stream video GUID; combined with the global library hostname this is enough
-- to derive HLS/iframe playback URLs without storing them.
ALTER TABLE "tracks" ADD COLUMN "bunny_video_id" text;
--> statement-breakpoint
-- Optional poster/thumbnail URL (Bunny auto-generates one; we cache it for offline UI).
ALTER TABLE "tracks" ADD COLUMN "video_poster_url" text;
