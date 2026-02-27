-- Add part_number column to sessions table
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "part_number" integer;
