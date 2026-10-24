ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "bibliography_pt" text;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "bibliography_en_reviewed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "bibliography_pt_reviewed" boolean DEFAULT true NOT NULL;