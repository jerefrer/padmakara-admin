ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "title_en" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "title_pt" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "title_en_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "title_pt_reviewed" boolean NOT NULL DEFAULT true;
