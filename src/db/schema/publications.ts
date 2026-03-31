import {
  pgTable,
  serial,
  text,
  date,
  timestamp,
  integer,
  bigint,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { events } from "./retreats.ts";

export const publications = pgTable("publications", {
  id: serial("id").primaryKey(),
  titlePt: text("title_pt").notNull(),
  titleEn: text("title_en"),
  subtitle: text("subtitle"),
  description: text("description"),
  authors: text("authors").array().notNull().default([]),
  language: text("language").notNull().default("pt"),
  pageCount: integer("page_count"),
  publicationDate: date("publication_date", { mode: "string" }),
  coverImageS3Key: text("cover_image_s3_key"),
  pdfS3Key: text("pdf_s3_key").notNull(),
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
  accessLevel: text("access_level").notNull().default("public"),
  sortOrder: integer("sort_order").notNull().default(0),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const eventPublications = pgTable(
  "event_publications",
  {
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    publicationId: integer("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.publicationId] })],
);

export const publicationsRelations = relations(publications, ({ many }) => ({
  eventPublications: many(eventPublications),
}));

export const eventPublicationsRelations = relations(eventPublications, ({ one }) => ({
  event: one(events, {
    fields: [eventPublications.eventId],
    references: [events.id],
  }),
  publication: one(publications, {
    fields: [eventPublications.publicationId],
    references: [publications.id],
  }),
}));
