ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "transcripts_published" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "texts_published" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "topics_published" boolean DEFAULT true NOT NULL;