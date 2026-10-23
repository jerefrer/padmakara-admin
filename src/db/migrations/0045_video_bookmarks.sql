CREATE TABLE IF NOT EXISTS "video_bookmarks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"video_id" integer NOT NULL,
	"position_seconds" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "video_bookmarks" ADD CONSTRAINT "video_bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_bookmarks" ADD CONSTRAINT "video_bookmarks_video_id_event_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."event_videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_bookmarks_user_id_idx" ON "video_bookmarks" USING btree ("user_id");