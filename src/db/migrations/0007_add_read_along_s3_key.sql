-- Add read_along_s3_key column to tracks table for Read Along alignment data
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "read_along_s3_key" text;
