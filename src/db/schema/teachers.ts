import {
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const teachers = pgTable("teachers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  abbreviation: text("abbreviation").notNull().unique(),
  aliases: text("aliases").array().notNull().default([]),
  photoUrl: text("photo_url"),
  avatarS3Key: text("avatar_s3_key"),
  heroS3Key: text("hero_s3_key"),
  avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
  heroUpdatedAt: timestamp("hero_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
