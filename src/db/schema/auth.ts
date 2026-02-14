import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users.ts";

export const refreshTokens = pgTable("refresh_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const magicLinkTokens = pgTable("magic_link_tokens", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  isUsed: boolean("is_used").notNull().default(false),
  // Device info — stored so we know which device to activate
  deviceFingerprint: text("device_fingerprint"),
  deviceName: text("device_name"),
  deviceType: text("device_type"),
  // User's preferred language for email and activation page
  language: text("language").notNull().default("en"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const deviceActivations = pgTable("device_activations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  deviceFingerprint: text("device_fingerprint").notNull().unique(),
  deviceName: text("device_name").notNull(),
  deviceType: text("device_type").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  activatedAt: timestamp("activated_at", { withTimezone: true }).defaultNow().notNull(),
  lastUsed: timestamp("last_used", { withTimezone: true }).defaultNow().notNull(),
});

export const userApprovalRequests = pgTable("user_approval_requests", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  message: text("message"),
  status: text("status").notNull().default("pending"), // pending | approved | rejected
  adminMessage: text("admin_message"),
  deviceFingerprint: text("device_fingerprint"),
  deviceName: text("device_name"),
  deviceType: text("device_type"),
  // User's preferred language for approval communications
  language: text("language").notNull().default("en"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedById: integer("reviewed_by_id").references(() => users.id),
});

// Relations
export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, {
    fields: [refreshTokens.userId],
    references: [users.id],
  }),
}));

export const deviceActivationsRelations = relations(deviceActivations, ({ one }) => ({
  user: one(users, {
    fields: [deviceActivations.userId],
    references: [users.id],
  }),
}));

export const userApprovalRequestsRelations = relations(userApprovalRequests, ({ one }) => ({
  reviewedBy: one(users, {
    fields: [userApprovalRequests.reviewedById],
    references: [users.id],
  }),
}));
