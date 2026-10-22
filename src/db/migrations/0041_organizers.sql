-- Organizers become predefined entities, handled like places.
--
-- `retreats.organizer` was free text (comma-joined when several), so the same
-- organisation could be typed three ways. Now there is an `organizers` table
-- and an ordered junction `retreat_organizers` (position keeps the order the
-- admin chose, which is the order of the joined string clients still receive).
--
-- The table is seeded with the association's eight organisations. The
-- abbreviation is the spelling the library CSV uses, so the CSV resolves to them.
--
-- Backfill: every existing value is split on ", ", trimmed, mapped onto a seeded
-- organizer (no new rows) and linked in order. The migration refuses to drop
-- `organizer` if any value had no mapping or was not linked, rather than losing
-- it. Re-running it after the column is gone is a no-op.
CREATE TABLE IF NOT EXISTS organizers (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  abbreviation text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retreat_organizers (
  retreat_id integer NOT NULL REFERENCES retreats(id) ON DELETE CASCADE,
  organizer_id integer NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (retreat_id, organizer_id)
);

CREATE INDEX IF NOT EXISTS retreat_organizers_organizer_id_idx ON retreat_organizers (organizer_id);

INSERT INTO organizers (name, abbreviation) VALUES
  ('Fundação Kangyur Rinpoche', 'F. Kangyur R.'),
  ('Songtsen - Casa da Cultura do Tibete', 'Songtsen'),
  ('União Budista Portuguesa', 'U.B.P.'),
  ('Stupa - Associação para a Paz', 'Stupa'),
  ('Songtsen-Chanteloube', 'Songtsen-Chanteloube'),
  ('Ranjung Yeshe Gomde Portugal', NULL),
  ('Padmakara Lusófona', NULL),
  ('Tergar Portugal', NULL)
ON CONFLICT (name) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'retreats'
      AND column_name = 'organizer'
  ) THEN
    -- One row per (retreat, mapped organizer), ordered as written. A part with
    -- no mapping gets organizer_name NULL and is caught by the guard below.
    CREATE TEMP TABLE _organizer_backfill ON COMMIT DROP AS
    SELECT retreat_id, organizer_name, (row_number() OVER (PARTITION BY retreat_id ORDER BY ord) - 1)::int AS position
    FROM (
      SELECT retreat_id, organizer_name, min(ord) AS ord
      FROM (
        SELECT
          r.id AS retreat_id,
          CASE btrim(part.value)
            WHEN 'F. Kangyur Rinpoche' THEN 'Fundação Kangyur Rinpoche'
            WHEN 'Fundação Kangyur Rinpoche' THEN 'Fundação Kangyur Rinpoche'
            WHEN 'Casa da Cultura do Tibete' THEN 'Songtsen - Casa da Cultura do Tibete'
            WHEN 'Songtsen CCT' THEN 'Songtsen - Casa da Cultura do Tibete'
            WHEN 'Ranjung Yeshe Gomde Portugal' THEN 'Ranjung Yeshe Gomde Portugal'
            ELSE NULL
          END AS organizer_name,
          part.ord
        FROM retreats r,
             regexp_split_to_table(r.organizer, ',\s*') WITH ORDINALITY AS part(value, ord)
        WHERE btrim(coalesce(r.organizer, '')) <> ''
          AND btrim(part.value) <> ''
      ) parts
      GROUP BY retreat_id, organizer_name
    ) deduped;

    IF EXISTS (SELECT 1 FROM _organizer_backfill WHERE organizer_name IS NULL) THEN
      RAISE EXCEPTION 'retreats with an unmapped organizer value: refusing to drop organizer';
    END IF;

    INSERT INTO retreat_organizers (retreat_id, organizer_id, position)
    SELECT b.retreat_id, o.id, b.position
    FROM _organizer_backfill b
    JOIN organizers o ON o.name = b.organizer_name
    ON CONFLICT (retreat_id, organizer_id) DO NOTHING;

    IF EXISTS (
      SELECT 1 FROM _organizer_backfill b
      WHERE NOT EXISTS (
        SELECT 1 FROM retreat_organizers ro
        JOIN organizers o ON o.id = ro.organizer_id
        WHERE ro.retreat_id = b.retreat_id AND o.name = b.organizer_name
      )
    ) OR EXISTS (
      SELECT 1 FROM retreats r
      WHERE btrim(coalesce(r.organizer, '')) <> ''
        AND NOT EXISTS (SELECT 1 FROM retreat_organizers ro WHERE ro.retreat_id = r.id)
    ) THEN
      RAISE EXCEPTION 'retreats with an organizer that was not linked: refusing to drop organizer';
    END IF;

    ALTER TABLE retreats DROP COLUMN organizer;
  END IF;
END $$;
