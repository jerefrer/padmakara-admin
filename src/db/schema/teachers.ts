import {
  pgTable,
  serial,
  integer,
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
  heroFocalX: integer("hero_focal_x").notNull().default(50),
  heroFocalY: integer("hero_focal_y").notNull().default(50),
  avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
  heroUpdatedAt: timestamp("hero_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
