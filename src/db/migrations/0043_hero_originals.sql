ALTER TABLE "retreat_groups" ADD COLUMN IF NOT EXISTS "hero_original_s3_key" text;--> statement-breakpoint
ALTER TABLE "retreat_groups" ADD COLUMN IF NOT EXISTS "hero_crop" jsonb;--> statement-breakpoint
ALTER TABLE "retreat_groups" ADD COLUMN IF NOT EXISTS "hero_grayscale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "hero_original_s3_key" text;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "hero_crop" jsonb;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "hero_grayscale" boolean DEFAULT false NOT NULL;