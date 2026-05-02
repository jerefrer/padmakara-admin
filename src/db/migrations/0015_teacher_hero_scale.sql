-- Adds hero_scale (1.00 = 1x) so the admin can zoom hero images while keeping
-- the original full-resolution image in S3. The mobile app applies the scale
-- via a CSS/RN transform on top of objectFit:cover + objectPosition:focal.
ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "hero_scale" integer NOT NULL DEFAULT 100;
