CREATE TABLE IF NOT EXISTS "import_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_code" text NOT NULL,
	"source_bucket" text DEFAULT 'padmakara-pt' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed_structure" jsonb,
	"confirmed_structure" jsonb,
	"retreat_id" integer,
	"file_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_by" integer,
	"cataloged_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_jobs_event_code_unique" UNIQUE("event_code")
);

CREATE TABLE IF NOT EXISTS "import_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"import_job_id" integer NOT NULL,
	"source_s3_key" text NOT NULL,
	"zip_entry_name" text,
	"filename" text NOT NULL,
	"extension" text NOT NULL,
	"size_bytes" bigint,
	"category" text,
	"language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_retreat_id_retreats_id_fk"
		FOREIGN KEY ("retreat_id") REFERENCES "retreats"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
	ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_users_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
	ALTER TABLE "import_files" ADD CONSTRAINT "import_files_import_job_id_import_jobs_id_fk"
		FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "import_files_import_job_id_idx"
	ON "import_files" ("import_job_id");
