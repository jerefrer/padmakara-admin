-- Adds avatar/hero image fields to retreat_groups, mirroring the teacher
-- image system. Hero images are stored full-size in S3 and rendered with a
-- focal point + zoom transform on the client (objectFit:cover + objectPosition).
ALTER TABLE "retreat_groups" ADD COLUMN IF NOT EXISTS "avatar_s3_key" text;
ALTER TABLE "retreat_groups" ADD COLUMN IF NOT EXISTS "hero_s3_key" text;
ALTER TABLE "retreat_groups" ADD COLUMN IF NOT EXISTS "hero_focal_x" integer NOT NULL DEFAULT 50;
ALTER TABLE "retreat_groups" ADD COLUMN IF NOT EXISTS "hero_focal_y" integer NOT NULL DEFAULT 50;
ALTER TABLE "retreat_groups" ADD COLUMN IF NOT EXISTS "hero_scale" integer NOT NULL DEFAULT 100;
ALTER TABLE "retreat_groups" ADD COLUMN IF NOT EXISTS "avatar_updated_at" timestamp with time zone;
ALTER TABLE "retreat_groups" ADD COLUMN IF NOT EXISTS "hero_updated_at" timestamp with time zone;
