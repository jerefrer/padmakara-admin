import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

export const eventTypes = pgTable("event_types", {
  id: serial("id").primaryKey(),
  nameEn: text("name_en").notNull(),
  namePt: text("name_pt"),
  abbreviation: text("abbreviation").notNull(),
  slug: text("slug").notNull().unique(),
  displayOrder: integer("display_order").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
