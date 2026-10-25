-- Only one event may hold the home-page highlight, and only a published one.
-- Keep the most recently starred PUBLISHED event; clear every other star.
-- IS DISTINCT FROM (not <>) so that when no published event is starred the
-- subquery is NULL and every remaining star is still cleared.
UPDATE retreats
SET featured_at = NULL
WHERE featured_at IS NOT NULL
  AND id IS DISTINCT FROM (
    SELECT id FROM retreats
    WHERE featured_at IS NOT NULL AND status = 'published'
    ORDER BY featured_at DESC
    LIMIT 1
  );
--> statement-breakpoint
-- At most one row may have featured_at set. drizzle-kit cannot express an
-- expression index on (true), so this index exists only in SQL.
CREATE UNIQUE INDEX IF NOT EXISTS retreats_single_featured_idx ON retreats ((true)) WHERE featured_at IS NOT NULL;
