-- Move the video relationship from tracks to sessions.
--
-- The original Phase 1 design treated audio and video as parallel tracks. In
-- practice, audio is chopped into many topic-indexed tracks by a curator
-- while the video is one continuous recording covering the same teaching.
-- The video is therefore a property of the session, not a separate track.
--
-- Migration is destructive only for the now-deprecated track-level video
-- columns; nothing else is touched. Existing dev data has no video tracks
-- yet so the data drop is a no-op in practice.

ALTER TABLE "sessions" ADD COLUMN "bunny_video_id" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "video_duration_seconds" integer;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "video_poster_url" text;
--> statement-breakpoint
ALTER TABLE "tracks" DROP COLUMN IF EXISTS "media_type";
--> statement-breakpoint
ALTER TABLE "tracks" DROP COLUMN IF EXISTS "bunny_video_id";
--> statement-breakpoint
ALTER TABLE "tracks" DROP COLUMN IF EXISTS "video_poster_url";
