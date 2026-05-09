-- Drop the unused user_notes table.
--
-- The notes feature was implemented backend-only (CRUD routes + this table),
-- but never wired up on the frontend. We're removing it pending a "do we
-- actually need this?" decision; the table has no rows in production. If
-- notes come back later, they'll get a fresh schema in a new migration.

DROP TABLE IF EXISTS "user_notes";
