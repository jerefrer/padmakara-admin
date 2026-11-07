ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "audio_published" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "video_published" boolean DEFAULT true NOT NULL;
