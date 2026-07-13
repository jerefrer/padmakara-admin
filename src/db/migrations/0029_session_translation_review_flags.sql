ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "title_en_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "title_pt_reviewed" boolean NOT NULL DEFAULT true;
