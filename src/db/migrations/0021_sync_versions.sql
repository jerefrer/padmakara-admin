-- Per-namespace integer counters used for client-side cache invalidation.
-- Bumped by admin CRUD routes whenever a tracked entity changes; clients
-- compare against their last-known counter via GET /api/sync/versions.
CREATE TABLE IF NOT EXISTS "sync_versions" (
  "namespace" varchar(64) PRIMARY KEY,
  "version" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Seed the four namespaces tracked by Phase A. ON CONFLICT DO NOTHING so
-- re-running the migration is a no-op.
INSERT INTO "sync_versions" ("namespace", "version") VALUES
  ('groups', 1),
  ('events', 1),
  ('teachers', 1),
  ('publications', 1)
ON CONFLICT ("namespace") DO NOTHING;
