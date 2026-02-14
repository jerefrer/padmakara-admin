import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  integer,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { retreatGroups } from "./retreat-groups.ts";
import { events } from "./retreats.ts";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  dharmaName: text("dharma_name"),
  preferredLanguage: text("preferred_language").notNull().default("en"),
  role: text("role").notNull().default("user"),
  isActive: boolean("is_active").notNull().default(true),
  isVerified: boolean("is_verified").notNull().default(false),
  // Subscription fields
  subscriptionStatus: text("subscription_status").notNull().default("none"), // "active" | "expired" | "none"
  subscriptionSource: text("subscription_source"), // "easypay" | "cash" | "admin" | "bank_transfer"
  subscriptionExpiresAt: timestamp("subscription_expires_at", { withTimezone: true }),
  subscriptionNotes: text("subscription_notes"),
  easypaySubscriptionId: text("easypay_subscription_id").unique(),
  lastActivity: timestamp("last_activity", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userGroupMemberships = pgTable(
  "user_group_memberships",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    retreatGroupId: integer("retreat_group_id")
      .notNull()
      .references(() => retreatGroups.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("confirmed"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.retreatGroupId] })],
);

export const userEventAttendance = pgTable(
  "user_retreat_attendance",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: integer("retreat_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("registered"),
    registeredAt: timestamp("registered_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventId] })],
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  groupMemberships: many(userGroupMemberships),
  eventAttendance: many(userEventAttendance),
}));

export const userGroupMembershipsRelations = relations(userGroupMemberships, ({ one }) => ({
  user: one(users, {
    fields: [userGroupMemberships.userId],
    references: [users.id],
  }),
  retreatGroup: one(retreatGroups, {
    fields: [userGroupMemberships.retreatGroupId],
    references: [retreatGroups.id],
  }),
}));

export const userEventAttendanceRelations = relations(userEventAttendance, ({ one }) => ({
  user: one(users, {
    fields: [userEventAttendance.userId],
    references: [users.id],
  }),
  event: one(events, {
    fields: [userEventAttendance.eventId],
    references: [events.id],
  }),
}));
