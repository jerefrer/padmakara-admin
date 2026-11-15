ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "avatar_s3_key" text;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "hero_s3_key" text;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "hero_mobile_s3_key" text;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "hero_focal_x" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "hero_focal_y" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "hero_scale" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "hero_original_s3_key" text;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "hero_crop" jsonb;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "hero_grayscale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "hero_frame_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "avatar_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "hero_updated_at" timestamp with time zone;