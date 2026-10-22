import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import type { HeroCrop } from "./teachers.ts";

export const retreatGroups = pgTable("retreat_groups", {
  id: serial("id").primaryKey(),
  nameEn: text("name_en").notNull(),
  namePt: text("name_pt"),
  abbreviation: text("abbreviation").unique(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  logoUrl: text("logo_url"),
  avatarS3Key: text("avatar_s3_key"),
  heroS3Key: text("hero_s3_key"),
  heroMobileS3Key: text("hero_mobile_s3_key"),
  heroFocalX: integer("hero_focal_x").notNull().default(50),
  heroFocalY: integer("hero_focal_y").notNull().default(50),
  heroScale: integer("hero_scale").notNull().default(100),
  // The hero as uploaded, before any crop, so the admin can always re-frame it. The crop
  // (in pixels of the original) and the black-and-white choice are re-applied on re-edit.
  heroOriginalS3Key: text("hero_original_s3_key"),
  heroCrop: jsonb("hero_crop").$type<HeroCrop>(),
  heroGrayscale: boolean("hero_grayscale").notNull().default(false),
  avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
  heroUpdatedAt: timestamp("hero_updated_at", { withTimezone: true }),
  displayOrder: integer("display_order").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
