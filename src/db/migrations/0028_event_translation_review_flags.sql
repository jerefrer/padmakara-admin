ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "title_en_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "title_pt_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "main_themes_en_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "main_themes_pt_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "session_themes_en_reviewed" boolean NOT NULL DEFAULT true;
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "session_themes_pt_reviewed" boolean NOT NULL DEFAULT true;
