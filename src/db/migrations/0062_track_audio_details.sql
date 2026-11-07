ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "bitrate_kbps" integer;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "sample_rate_hz" integer;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "channels" integer;