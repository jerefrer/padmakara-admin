ALTER TABLE "retreat_teachers" ADD COLUMN IF NOT EXISTS "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "guest_intro" text;--> statement-breakpoint
-- Number the existing links in the order clients receive them today (the rows'
-- physical order, i.e. the order the admin saved them), per event and role.
-- Only rows still all at 0 are touched, so re-running changes nothing.
UPDATE "retreat_teachers" AS rt
SET "position" = numbered.pos
FROM (
  SELECT ctid AS row_id,
         (row_number() OVER (PARTITION BY "retreat_id", "role" ORDER BY ctid) - 1)::integer AS pos
  FROM "retreat_teachers"
  WHERE "retreat_id" NOT IN (SELECT "retreat_id" FROM "retreat_teachers" WHERE "position" <> 0)
) AS numbered
WHERE rt.ctid = numbered.row_id;
