-- Adds the columns introduced by commit 88815cd (teacher avatar / hero image
-- support) which never had a migration generated. Production was running on
-- the schema through 0012, while the application code (Drizzle relations)
-- expects these columns. Result: every event admin endpoint that loads
-- teacher relations returned 500. Backfill the missing columns idempotently.
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "avatar_s3_key" text;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "hero_s3_key" text;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "hero_focal_x" integer NOT NULL DEFAULT 50;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "hero_focal_y" integer NOT NULL DEFAULT 50;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "avatar_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "hero_updated_at" timestamp with time zone;
