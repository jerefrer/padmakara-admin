import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uuid,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { users } from "./users.ts";
import { events } from "./retreats.ts";

/**
 * One-off purchase (or free claim) of a single teaching. `publicId` is what
 * appears in URLs; the serial id never leaves the server.
 * status: pending | paid | failed | expired | cancelled
 */
export const teachingOrders = pgTable(
  "teaching_orders",
  {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id")
      .notNull()
      .unique()
      .default(sql`gen_random_uuid()`),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    language: text("language").notNull().default("pt"),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("pending"),
    easypayCheckoutId: text("easypay_checkout_id"),
    easypayPaymentId: text("easypay_payment_id"),
    /** mb | mbw | cc ... once known. */
    method: text("method"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (t) => [
    index("teaching_orders_event_id_idx").on(t.eventId),
    index("teaching_orders_user_id_idx").on(t.userId),
    index("teaching_orders_easypay_checkout_id_idx").on(t.easypayCheckoutId),
    index("teaching_orders_easypay_payment_id_idx").on(t.easypayPaymentId),
  ],
);

/**
 * Grants a user access to one event whatever its audience and whatever their
 * subscription. source: purchase | free | manual.
 * Inserts use ON CONFLICT DO NOTHING (an existing grant wins).
 */
export const eventAccessGrants = pgTable(
  "event_access_grants",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    orderId: integer("order_id").references(() => teachingOrders.id, {
      onDelete: "set null",
    }),
    /** The admin who granted it (manual grants only). */
    grantedBy: integer("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.eventId] }),
    index("event_access_grants_event_id_idx").on(t.eventId),
  ],
);

export const teachingOrdersRelations = relations(teachingOrders, ({ one }) => ({
  event: one(events, { fields: [teachingOrders.eventId], references: [events.id] }),
  user: one(users, { fields: [teachingOrders.userId], references: [users.id] }),
}));

export const eventAccessGrantsRelations = relations(eventAccessGrants, ({ one }) => ({
  user: one(users, {
    fields: [eventAccessGrants.userId],
    references: [users.id],
    relationName: "grantee",
  }),
  event: one(events, { fields: [eventAccessGrants.eventId], references: [events.id] }),
  order: one(teachingOrders, {
    fields: [eventAccessGrants.orderId],
    references: [teachingOrders.id],
  }),
}));
