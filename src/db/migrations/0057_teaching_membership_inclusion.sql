ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "included_in_membership" boolean DEFAULT false NOT NULL;
