CREATE TABLE IF NOT EXISTS "event_access_grants" (
	"user_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"source" text NOT NULL,
	"order_id" integer,
	"granted_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_access_grants_user_id_event_id_pk" PRIMARY KEY("user_id","event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teaching_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"event_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"email" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"language" text DEFAULT 'pt' NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"easypay_checkout_id" text,
	"easypay_payment_id" text,
	"method" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "teaching_orders_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "sale_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "retreats" ADD COLUMN IF NOT EXISTS "price_cents" integer;--> statement-breakpoint
ALTER TABLE "event_access_grants" ADD CONSTRAINT "event_access_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_access_grants" ADD CONSTRAINT "event_access_grants_event_id_retreats_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_access_grants" ADD CONSTRAINT "event_access_grants_order_id_teaching_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."teaching_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_access_grants" ADD CONSTRAINT "event_access_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_orders" ADD CONSTRAINT "teaching_orders_event_id_retreats_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."retreats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_orders" ADD CONSTRAINT "teaching_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_access_grants_event_id_idx" ON "event_access_grants" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teaching_orders_event_id_idx" ON "teaching_orders" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teaching_orders_user_id_idx" ON "teaching_orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teaching_orders_easypay_checkout_id_idx" ON "teaching_orders" USING btree ("easypay_checkout_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teaching_orders_easypay_payment_id_idx" ON "teaching_orders" USING btree ("easypay_payment_id");