CREATE TYPE "public"."file_action" AS ENUM('include', 'ignore', 'rename', 'review');--> statement-breakpoint
CREATE TYPE "public"."file_category" AS ENUM('audio_main', 'audio_translation', 'audio_legacy', 'video', 'transcript', 'document', 'image', 'archive', 'other');--> statement-breakpoint
CREATE TYPE "public"."log_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."migration_status" AS ENUM('uploaded', 'analyzing', 'analyzed', 'decisions_pending', 'decisions_complete', 'approved', 'executing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "audiences" (
	"id" serial PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_pt" text,
	"slug" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audiences_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "device_activations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"device_fingerprint" text NOT NULL,
	"device_name" text NOT NULL,
	"device_type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_activations_device_fingerprint_unique" UNIQUE("device_fingerprint")
);
--> statement-breakpoint
CREATE TABLE "download_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_size" bigint,
	"download_url" text,
	"s3_key" text,
	"error_message" text,
	"retry_count" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"total_files" integer,
	"processed_files" integer DEFAULT 0 NOT NULL,
	"progress_percent" smallint DEFAULT 0 NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processing_completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "event_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"session_id" integer,
	"original_filename" text NOT NULL,
	"s3_key" text NOT NULL,
	"file_type" text NOT NULL,
	"extension" text NOT NULL,
	"file_size_bytes" bigint,
	"language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_pt" text,
	"abbreviation" text NOT NULL,
	"slug" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_types_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "media_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"file_type" text NOT NULL,
	"category" "file_category" NOT NULL,
	"filename" text NOT NULL,
	"s3_key" text NOT NULL,
	"s3_bucket" text DEFAULT 'padmakara-pt-app' NOT NULL,
	"file_size" integer,
	"mime_type" text NOT NULL,
	"duration" integer,
	"bitrate" integer,
	"codec" text,
	"resolution" text,
	"session_number" integer,
	"track_number" integer,
	"is_translation" boolean DEFAULT false,
	"is_legacy" boolean DEFAULT false,
	"language" text,
	"page_count" integer,
	"is_public" boolean DEFAULT true,
	"metadata" jsonb,
	"migrated_from" text,
	"migration_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_file_catalogs" (
	"id" serial PRIMARY KEY NOT NULL,
	"migration_id" integer NOT NULL,
	"event_code" text NOT NULL,
	"s3_directory" text NOT NULL,
	"filename" text NOT NULL,
	"s3_key" text NOT NULL,
	"file_type" text NOT NULL,
	"category" "file_category" NOT NULL,
	"extension" text NOT NULL,
	"file_size" integer,
	"mime_type" text NOT NULL,
	"suggested_action" "file_action" DEFAULT 'review' NOT NULL,
	"suggested_category" "file_category",
	"conflicts" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_file_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"migration_id" integer NOT NULL,
	"catalog_id" integer NOT NULL,
	"action" "file_action" NOT NULL,
	"new_filename" text,
	"target_category" "file_category",
	"target_s3_key" text,
	"notes" text,
	"decided_by" integer,
	"decided_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"migration_id" integer NOT NULL,
	"level" "log_level" DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"event_code" text,
	"context" jsonb,
	"timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"csv_file_path" text NOT NULL,
	"csv_row_count" integer,
	"status" "migration_status" DEFAULT 'uploaded' NOT NULL,
	"analysis_data" jsonb,
	"target_bucket" text DEFAULT 'padmakara-pt-app' NOT NULL,
	"progress_percentage" integer DEFAULT 0,
	"processed_events" integer DEFAULT 0,
	"successful_events" integer DEFAULT 0,
	"failed_events" integer DEFAULT 0,
	"skipped_events" integer DEFAULT 0,
	"analyzed_at" timestamp,
	"execution_started_at" timestamp,
	"execution_completed_at" timestamp,
	"created_by" integer,
	"approved_by" integer,
	"approved_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_approval_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"message" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"admin_message" text,
	"device_fingerprint" text,
	"device_name" text,
	"device_type" text,
	"language" text DEFAULT 'en' NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_id" integer
);
--> statement-breakpoint
ALTER TABLE "retreats" RENAME COLUMN "audience" TO "audience_id";--> statement-breakpoint
ALTER TABLE "transcripts" DROP CONSTRAINT "transcripts_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD COLUMN "device_fingerprint" text;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD COLUMN "device_name" text;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD COLUMN "device_type" text;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "retreat_groups" ADD COLUMN "abbreviation" text;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN "event_type_id" integer;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "is_practice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "file_format" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "subscription_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "subscription_source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "subscription_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "subscription_notes" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "easypay_subscription_id" text;--> statement-breakpoint
ALTER TABLE "device_activations" ADD CONSTRAINT "device_activations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_requests" ADD CONSTRAINT "download_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_requests" ADD CONSTRAINT "download_requests_event_id_retreats_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_files" ADD CONSTRAINT "event_files_event_id_retreats_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_files" ADD CONSTRAINT "event_files_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_event_id_retreats_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_migration_id_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_file_catalogs" ADD CONSTRAINT "migration_file_catalogs_migration_id_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_file_decisions" ADD CONSTRAINT "migration_file_decisions_migration_id_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_file_decisions" ADD CONSTRAINT "migration_file_decisions_catalog_id_migration_file_catalogs_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."migration_file_catalogs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_file_decisions" ADD CONSTRAINT "migration_file_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_logs" ADD CONSTRAINT "migration_logs_migration_id_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."migrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_approval_requests" ADD CONSTRAINT "user_approval_requests_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retreats" ADD CONSTRAINT "retreats_event_type_id_event_types_id_fk" FOREIGN KEY ("event_type_id") REFERENCES "public"."event_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retreats" ADD CONSTRAINT "retreats_audience_id_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."audiences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retreats" DROP COLUMN "designation";--> statement-breakpoint
ALTER TABLE "transcripts" DROP COLUMN "session_id";--> statement-breakpoint
ALTER TABLE "retreat_groups" ADD CONSTRAINT "retreat_groups_abbreviation_unique" UNIQUE("abbreviation");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_easypay_subscription_id_unique" UNIQUE("easypay_subscription_id");