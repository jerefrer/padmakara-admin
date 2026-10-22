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
import { audiences } from "./audiences.ts";
import { retreatGroups } from "./retreat-groups.ts";
import { users } from "./users.ts";

export const publications = pgTable("publications", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  description: text("description"),
  authors: text("authors").array().notNull().default([]),
  language: text("language").notNull().default("pt"),
  pageCount: integer("page_count"),
  version: text("version"),
  publicationDate: date("publication_date", { mode: "string" }),
  coverImageS3Key: text("cover_image_s3_key"),
  pdfS3Key: text("pdf_s3_key").notNull(),
  fileSizeBytes: bigint("file_size_bytes", { mode: "number" }),
  audienceId: integer("audience_id").references(() => audiences.id, {
    onDelete: "set null",
  }),
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

/** Retreat groups ticked on a publication: their members (or attendees of their events) get access. */
export const publicationRetreatGroups = pgTable(
  "publication_retreat_groups",
  {
    publicationId: integer("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    retreatGroupId: integer("retreat_group_id")
      .notNull()
      .references(() => retreatGroups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.publicationId, t.retreatGroupId] })],
);

/** Users an admin granted a hidden publication to. */
export const publicationAccessUsers = pgTable(
  "publication_access_users",
  {
    publicationId: integer("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.publicationId, t.userId] })],
);

export const publicationsRelations = relations(publications, ({ one, many }) => ({
  audience: one(audiences, {
    fields: [publications.audienceId],
    references: [audiences.id],
  }),
  eventPublications: many(eventPublications),
  retreatGroups: many(publicationRetreatGroups),
  accessUsers: many(publicationAccessUsers),
}));

export const publicationRetreatGroupsRelations = relations(publicationRetreatGroups, ({ one }) => ({
  publication: one(publications, {
    fields: [publicationRetreatGroups.publicationId],
    references: [publications.id],
  }),
  retreatGroup: one(retreatGroups, {
    fields: [publicationRetreatGroups.retreatGroupId],
    references: [retreatGroups.id],
  }),
}));

export const publicationAccessUsersRelations = relations(publicationAccessUsers, ({ one }) => ({
  publication: one(publications, {
    fields: [publicationAccessUsers.publicationId],
    references: [publications.id],
  }),
  user: one(users, {
    fields: [publicationAccessUsers.userId],
    references: [users.id],
  }),
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
