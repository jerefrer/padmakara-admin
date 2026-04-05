-- Add featured_at column to retreats table
-- Admins set this timestamp to feature an event on the app home screen.
-- The most recently featured published event is shown as the monthly highlight.
ALTER TABLE "retreats" ADD COLUMN "featured_at" timestamp with time zone;
