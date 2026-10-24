import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";

/** A crop rectangle in pixels of the original hero image. */
export interface HeroCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The app layouts a hero is framed for. Must match HERO_FRAMES in admin/src/components/HeroFramePreviews.tsx. */
export const HERO_FRAME_KEYS = ["home", "home-short", "page", "desk-home", "desk-page"] as const;
export type HeroFrameKey = (typeof HERO_FRAME_KEYS)[number];

/** One layout's own framing of the stored hero: focal point in % of the stored hero, zoom 1..3. */
export interface HeroFrameOverride {
  focalX: number;
  focalY: number;
  zoom: number;
}

/** Per-layout framing; a layout without an entry follows the hero's focal point. */
export type HeroFrameOverrides = Partial<Record<HeroFrameKey, HeroFrameOverride>>;

export const teachers = pgTable("teachers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  abbreviation: text("abbreviation").notNull().unique(),
  aliases: text("aliases").array().notNull().default([]),
  photoUrl: text("photo_url"),
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
  // Per-layout framing, tied to the stored crop: cleared whenever the hero or its crop changes.
  heroFrameOverrides: jsonb("hero_frame_overrides").$type<HeroFrameOverrides>(),
  avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
  heroUpdatedAt: timestamp("hero_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
