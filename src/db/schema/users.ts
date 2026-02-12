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
import { retreats } from "./retreats.ts";

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

export const userRetreatAttendance = pgTable(
  "user_retreat_attendance",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    retreatId: integer("retreat_id")
      .notNull()
      .references(() => retreats.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("registered"),
    registeredAt: timestamp("registered_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.retreatId] })],
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  groupMemberships: many(userGroupMemberships),
  retreatAttendance: many(userRetreatAttendance),
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

export const userRetreatAttendanceRelations = relations(userRetreatAttendance, ({ one }) => ({
  user: one(users, {
    fields: [userRetreatAttendance.userId],
    references: [users.id],
  }),
  retreat: one(retreats, {
    fields: [userRetreatAttendance.retreatId],
    references: [retreats.id],
  }),
}));
