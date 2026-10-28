import {
  pgTable,
  serial,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  uuid,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users.ts";

/** A passkey (WebAuthn credential) registered by a member. Public key only; no secret is stored. */
export const passkeyCredentials = pgTable(
  "passkey_credentials",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // base64url credential id, as sent by the authenticator
    credentialId: text("credential_id").notNull().unique(),
    // base64url COSE public key
    publicKey: text("public_key").notNull(),
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    transports: jsonb("transports").$type<string[]>(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    // Label shown in the app, taken from the user agent / platform at creation
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("passkey_credentials_user_id_idx").on(t.userId)],
);

/** Short-lived, single-use challenge for a passkey registration or sign-in ceremony. */
export const webauthnChallenges = pgTable("webauthn_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  challenge: text("challenge").notNull(),
  // Null for sign-in: the person is not known until the key answers.
  userId: integer("user_id"),
  purpose: text("purpose").$type<"register" | "login">().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
