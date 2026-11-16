ALTER TABLE "device_activations" ADD COLUMN IF NOT EXISTS "pending_claim" boolean DEFAULT false NOT NULL;
