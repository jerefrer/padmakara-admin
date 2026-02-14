CREATE TABLE "bookmarks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"track_id" integer NOT NULL,
	"position_seconds" integer NOT NULL,
	"title" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_link_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"is_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_link_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"abbreviation" text,
	"location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retreat_group_retreats" (
	"retreat_id" integer NOT NULL,
	"retreat_group_id" integer NOT NULL,
	CONSTRAINT "retreat_group_retreats_retreat_id_retreat_group_id_pk" PRIMARY KEY("retreat_id","retreat_group_id")
);
--> statement-breakpoint
CREATE TABLE "retreat_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_pt" text,
	"slug" text NOT NULL,
	"description" text,
	"logo_url" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retreat_groups_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "retreat_places" (
	"retreat_id" integer NOT NULL,
	"place_id" integer NOT NULL,
	CONSTRAINT "retreat_places_retreat_id_place_id_pk" PRIMARY KEY("retreat_id","place_id")
);
--> statement-breakpoint
CREATE TABLE "retreat_teachers" (
	"retreat_id" integer NOT NULL,
	"teacher_id" integer NOT NULL,
	"role" text DEFAULT 'teacher' NOT NULL,
	CONSTRAINT "retreat_teachers_retreat_id_teacher_id_role_pk" PRIMARY KEY("retreat_id","teacher_id","role")
);
--> statement-breakpoint
CREATE TABLE "retreats" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_code" text NOT NULL,
	"title_en" text NOT NULL,
	"title_pt" text,
	"main_themes_pt" text,
	"main_themes_en" text,
	"session_themes_en" text,
	"session_themes_pt" text,
	"start_date" date,
	"end_date" date,
	"designation" text,
	"audience" text DEFAULT 'members',
	"bibliography" text,
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"image_url" text,
	"s3_prefix" text,
	"wix_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retreats_event_code_unique" UNIQUE("event_code")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"retreat_id" integer NOT NULL,
	"title_en" text,
	"title_pt" text,
	"session_date" date,
	"time_period" text DEFAULT 'morning',
	"session_number" integer NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_retreat_id_session_number_unique" UNIQUE("retreat_id","session_number")
);
--> statement-breakpoint
CREATE TABLE "teachers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"abbreviation" text NOT NULL,
	"photo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"title" text NOT NULL,
	"track_number" integer NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"is_translation" boolean DEFAULT false NOT NULL,
	"original_track_id" integer,
	"s3_key" text,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"file_size_bytes" bigint,
	"original_filename" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracks_session_id_track_number_language_unique" UNIQUE("session_id","track_number","language")
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" serial PRIMARY KEY NOT NULL,
	"retreat_id" integer NOT NULL,
	"session_id" integer,
	"language" text NOT NULL,
	"s3_key" text,
	"page_count" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"original_filename" text,
	"file_size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_group_memberships" (
	"user_id" integer NOT NULL,
	"retreat_group_id" integer NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_group_memberships_user_id_retreat_group_id_pk" PRIMARY KEY("user_id","retreat_group_id")
);
--> statement-breakpoint
CREATE TABLE "user_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"retreat_id" integer,
	"track_id" integer,
	"title" text,
	"content" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"track_id" integer NOT NULL,
	"position_seconds" integer DEFAULT 0 NOT NULL,
	"completion_pct" real DEFAULT 0 NOT NULL,
	"is_completed" boolean DEFAULT false NOT NULL,
	"play_count" integer DEFAULT 0 NOT NULL,
	"total_listen_seconds" integer DEFAULT 0 NOT NULL,
	"last_played" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "user_progress_user_id_track_id_unique" UNIQUE("user_id","track_id")
);
--> statement-breakpoint
CREATE TABLE "user_retreat_attendance" (
	"user_id" integer NOT NULL,
	"retreat_id" integer NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_retreat_attendance_user_id_retreat_id_pk" PRIMARY KEY("user_id","retreat_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"first_name" text,
	"last_name" text,
	"dharma_name" text,
	"preferred_language" text DEFAULT 'en' NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"last_activity" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retreat_group_retreats" ADD CONSTRAINT "retreat_group_retreats_retreat_id_retreats_id_fk" FOREIGN KEY ("retreat_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retreat_group_retreats" ADD CONSTRAINT "retreat_group_retreats_retreat_group_id_retreat_groups_id_fk" FOREIGN KEY ("retreat_group_id") REFERENCES "public"."retreat_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retreat_places" ADD CONSTRAINT "retreat_places_retreat_id_retreats_id_fk" FOREIGN KEY ("retreat_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retreat_places" ADD CONSTRAINT "retreat_places_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retreat_teachers" ADD CONSTRAINT "retreat_teachers_retreat_id_retreats_id_fk" FOREIGN KEY ("retreat_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retreat_teachers" ADD CONSTRAINT "retreat_teachers_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_retreat_id_retreats_id_fk" FOREIGN KEY ("retreat_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_original_track_id_tracks_id_fk" FOREIGN KEY ("original_track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_retreat_id_retreats_id_fk" FOREIGN KEY ("retreat_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_memberships" ADD CONSTRAINT "user_group_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_group_memberships" ADD CONSTRAINT "user_group_memberships_retreat_group_id_retreat_groups_id_fk" FOREIGN KEY ("retreat_group_id") REFERENCES "public"."retreat_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_retreat_id_retreats_id_fk" FOREIGN KEY ("retreat_id") REFERENCES "public"."retreats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_progress" ADD CONSTRAINT "user_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_progress" ADD CONSTRAINT "user_progress_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_retreat_attendance" ADD CONSTRAINT "user_retreat_attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_retreat_attendance" ADD CONSTRAINT "user_retreat_attendance_retreat_id_retreats_id_fk" FOREIGN KEY ("retreat_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;