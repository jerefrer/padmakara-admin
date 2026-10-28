ALTER TABLE "magic_link_tokens" ADD COLUMN IF NOT EXISTS "code_hash" text;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD COLUMN IF NOT EXISTS "code_attempts" integer DEFAULT 0 NOT NULL;
