ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "published_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "published_notified_count" integer;
