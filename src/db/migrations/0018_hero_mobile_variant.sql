-- Adds a mobile-sized hero variant alongside the existing desktop hero.
-- The desktop hero (heroS3Key) is stored at 2400px wide; the mobile hero
-- (hero_mobile_s3_key) is stored at 1200px wide. The frontend picks the
-- right variant based on viewport width to avoid downloading the desktop
-- file on phones. Avatars stay single-resolution — 400x400 is already
-- enough for every place they render.
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "hero_mobile_s3_key" text;
ALTER TABLE "retreat_groups" ADD COLUMN IF NOT EXISTS "hero_mobile_s3_key" text;
