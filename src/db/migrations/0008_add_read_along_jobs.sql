CREATE TABLE IF NOT EXISTS "read_along_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" integer NOT NULL REFERENCES "retreats"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'pending' NOT NULL,
  "batch_job_id" text,
  "language" text DEFAULT 'en' NOT NULL,
  "skip_pages" smallint DEFAULT 7 NOT NULL,
  "whisper_model" text DEFAULT 'turbo' NOT NULL,
  "uploaded_files" jsonb,
  "summary" jsonb,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "submitted_at" timestamp with time zone,
  "completed_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "read_along_jobs_event_id_idx" ON "read_along_jobs" ("event_id");
CREATE INDEX IF NOT EXISTS "read_along_jobs_status_idx" ON "read_along_jobs" ("status");
