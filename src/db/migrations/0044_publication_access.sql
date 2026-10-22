CREATE TABLE "publication_access_users" (
	"publication_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	CONSTRAINT "publication_access_users_publication_id_user_id_pk" PRIMARY KEY("publication_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "publication_retreat_groups" (
	"publication_id" integer NOT NULL,
	"retreat_group_id" integer NOT NULL,
	CONSTRAINT "publication_retreat_groups_publication_id_retreat_group_id_pk" PRIMARY KEY("publication_id","retreat_group_id")
);
--> statement-breakpoint
ALTER TABLE "publication_access_users" ADD CONSTRAINT "publication_access_users_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_access_users" ADD CONSTRAINT "publication_access_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_retreat_groups" ADD CONSTRAINT "publication_retreat_groups_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_retreat_groups" ADD CONSTRAINT "publication_retreat_groups_retreat_group_id_retreat_groups_id_fk" FOREIGN KEY ("retreat_group_id") REFERENCES "public"."retreat_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "audiences" ("name_en", "name_pt", "slug", "display_order")
SELECT 'Restricted', 'Restrito', 'restricted', COALESCE(MAX("display_order"), 0) + 1 FROM "audiences"
ON CONFLICT ("slug") DO NOTHING;
