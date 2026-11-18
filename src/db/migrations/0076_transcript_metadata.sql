-- Per-file transcript metadata (André + Jérémy, 2026-11-18).
--
-- `published` decides whether non-admins see a file. Existing rows were all
-- visible, so the column is added with DEFAULT true to keep them published,
-- then the default becomes false: a new upload starts unpublished until an
-- admin switches it on.
ALTER TABLE "transcripts" ADD COLUMN IF NOT EXISTS "is_excerpt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN IF NOT EXISTS "published" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ALTER COLUMN "published" SET DEFAULT false;--> statement-breakpoint
-- `status` was written ('published' by the seed and the admin, 'draft' by the
-- column default) but never read, so every existing value meant "the file as
-- served". It now describes the revision state; map everything outside the new
-- vocabulary to 'final' before constraining it.
UPDATE "transcripts" SET "status" = 'final' WHERE "status" NOT IN ('final', 'provisional', 'unrevised');--> statement-breakpoint
ALTER TABLE "transcripts" ALTER COLUMN "status" SET DEFAULT 'final';--> statement-breakpoint
ALTER TABLE "transcripts" DROP CONSTRAINT IF EXISTS "transcripts_status_check";--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_status_check" CHECK ("transcripts"."status" IN ('final', 'provisional', 'unrevised', 'draft'));
