-- Per-user counter bumped when admin actions change a user's access to events,
-- groups, or publications. Returned alongside the global namespace versions
-- in GET /api/sync/versions so the affected user's cache resyncs.
CREATE TABLE IF NOT EXISTS "user_sync_versions" (
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "version" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "user_sync_versions_pkey" PRIMARY KEY ("user_id")
);
