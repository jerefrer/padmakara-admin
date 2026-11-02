ALTER TABLE "event_videos" ADD COLUMN IF NOT EXISTS "burn_master_bytes" bigint;--> statement-breakpoint
ALTER TABLE "event_videos" ADD COLUMN IF NOT EXISTS "burn_peak_disk_bytes" bigint;