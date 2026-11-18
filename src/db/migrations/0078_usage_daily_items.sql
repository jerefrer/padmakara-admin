CREATE TABLE IF NOT EXISTS "usage_daily_items" (
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"event_id" integer DEFAULT 0 NOT NULL,
	"item_id" integer NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_items_day_metric_item_id_pk" PRIMARY KEY("day","metric","item_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_daily_items_event_id_day_idx" ON "usage_daily_items" USING btree ("event_id","day");
