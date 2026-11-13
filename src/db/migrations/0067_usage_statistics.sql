CREATE TABLE IF NOT EXISTS "usage_daily" (
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"event_id" integer DEFAULT 0 NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_day_metric_event_id_pk" PRIMARY KEY("day","metric","event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_active_days" (
	"user_id" integer NOT NULL,
	"day" date NOT NULL,
	CONSTRAINT "user_active_days_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_active_days" ADD CONSTRAINT "user_active_days_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_active_days_day_idx" ON "user_active_days" USING btree ("day");