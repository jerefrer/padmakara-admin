-- The folder under events/ that holds an event's files, fixed at creation so the
-- editable event_code (the library import rewrites it) no longer decides where files live.
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "storage_prefix" text;--> statement-breakpoint
-- Backfill: the folder the event's files already sit in. Tracks first (most common
-- folder among their s3_key "events/<folder>/..."), then transcripts, then the code.
UPDATE "retreats" r SET "storage_prefix" = COALESCE(
  (SELECT split_part(t.s3_key, '/', 2)
     FROM "tracks" t JOIN "sessions" s ON s.id = t.session_id
    WHERE s.retreat_id = r.id AND t.s3_key LIKE 'events/%/%'
    GROUP BY split_part(t.s3_key, '/', 2)
    ORDER BY count(*) DESC, split_part(t.s3_key, '/', 2)
    LIMIT 1),
  (SELECT split_part(x.s3_key, '/', 2)
     FROM "transcripts" x
    WHERE x.retreat_id = r.id AND x.s3_key LIKE 'events/%/%'
    GROUP BY split_part(x.s3_key, '/', 2)
    ORDER BY count(*) DESC, split_part(x.s3_key, '/', 2)
    LIMIT 1),
  r.event_code
) WHERE r."storage_prefix" IS NULL;--> statement-breakpoint
ALTER TABLE "retreats" ALTER COLUMN "storage_prefix" SET NOT NULL;
