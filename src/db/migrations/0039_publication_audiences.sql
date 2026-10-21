-- Publications get the same audiences as events.
--
-- `access_level` ('public' | 'subscribers' | 'events') could only say "open",
-- "members" or "like its events". The association asked for exactly the options
-- events have, with the events a publication is linked to deciding who gets
-- in for the event-based ones. So the publication now points at the same
-- `audiences` rows.
--
-- Backfill: public -> free-anyone, subscribers -> free-subscribers,
-- events -> event-participants (the closest event rule to "like its events").
-- The migration refuses to drop `access_level` if any row could not be
-- mapped, rather than leaving a publication with no audience (which the API
-- treats as closed). Re-running it after the column is gone is a no-op.
ALTER TABLE publications
  ADD COLUMN IF NOT EXISTS audience_id integer REFERENCES audiences(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'publications'
      AND column_name = 'access_level'
  ) THEN
    UPDATE publications p
    SET audience_id = a.id
    FROM audiences a
    WHERE p.audience_id IS NULL
      AND a.slug = CASE p.access_level
        WHEN 'public' THEN 'free-anyone'
        WHEN 'subscribers' THEN 'free-subscribers'
        WHEN 'events' THEN 'event-participants'
      END;

    IF EXISTS (SELECT 1 FROM publications WHERE audience_id IS NULL) THEN
      RAISE EXCEPTION 'publications without an audience after backfill: refusing to drop access_level';
    END IF;

    ALTER TABLE publications DROP COLUMN access_level;
  END IF;
END $$;
