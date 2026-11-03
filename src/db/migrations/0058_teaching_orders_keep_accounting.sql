ALTER TABLE "teaching_orders" DROP CONSTRAINT IF EXISTS "teaching_orders_event_id_retreats_id_fk";
--> statement-breakpoint
ALTER TABLE "teaching_orders" DROP CONSTRAINT IF EXISTS "teaching_orders_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "teaching_orders" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "teaching_orders" ADD CONSTRAINT "teaching_orders_event_id_retreats_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."retreats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teaching_orders" ADD CONSTRAINT "teaching_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;