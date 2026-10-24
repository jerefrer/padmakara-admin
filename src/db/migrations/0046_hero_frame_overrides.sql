ALTER TABLE "retreat_groups" ADD COLUMN IF NOT EXISTS "hero_frame_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "hero_frame_overrides" jsonb;