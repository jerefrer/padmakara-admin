CREATE TABLE IF NOT EXISTS "user_publication_opens" (
	"user_id" integer NOT NULL,
	"publication_id" integer NOT NULL,
	"last_opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"open_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "user_publication_opens_user_id_publication_id_pk" PRIMARY KEY("user_id","publication_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_publication_opens" ADD CONSTRAINT "user_publication_opens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_publication_opens" ADD CONSTRAINT "user_publication_opens_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
