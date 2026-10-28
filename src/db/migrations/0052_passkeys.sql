CREATE TABLE IF NOT EXISTS "passkey_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "passkey_credentials_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webauthn_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge" text NOT NULL,
	"user_id" integer,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passkey_credentials" ADD CONSTRAINT "passkey_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_credentials_user_id_idx" ON "passkey_credentials" USING btree ("user_id");