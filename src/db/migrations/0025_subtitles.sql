CREATE TABLE IF NOT EXISTS "subtitle_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" integer NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'pending' NOT NULL,
  "batch_job_id" text,
  "language" text DEFAULT 'en' NOT NULL,
  "whisper_model" text DEFAULT 'turbo' NOT NULL,
  "model" text,
  "summary" jsonb,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "submitted_at" timestamp with time zone,
  "completed_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "session_subtitles" (
  "id" serial PRIMARY KEY NOT NULL,
  "session_id" integer NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "language" text NOT NULL,
  "label" text NOT NULL,
  "s3_key" text NOT NULL,
  "origin" text DEFAULT 'transcription' NOT NULL,
  "source" text DEFAULT 'auto' NOT NULL,
  "stale" boolean DEFAULT false NOT NULL,
  "bunny_uploaded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "session_subtitles_session_id_language_unique" UNIQUE("session_id","language")
);
