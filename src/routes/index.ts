import { Hono } from "hono";
import { config } from "../config.ts";
import { auth } from "./auth.ts";
import { admin } from "./admin/index.ts";
import { eventRoutes } from "./events.ts";
import { groupRoutes } from "./groups.ts";
import { contentRoutes } from "./content.ts";
import { mediaRoutes } from "./media.ts";
import { userRoutes } from "./users.ts";
import { downloadsRoutes } from "./downloads.ts";
import { paymentRoutes } from "./payment.ts";
import { searchRoutes } from "./search.ts";
import { webhookRoutes } from "./webhooks.ts";
import { publicationRoutes } from "./publications.ts";
import { syncRoutes } from "./sync.ts";
import { teacherRoutes } from "./teachers.ts";
import { testRoutes } from "./test.ts";

const api = new Hono();

// Auth (public endpoints)
api.route("/auth", auth);

// Webhooks (public, HMAC-authenticated)
api.route("/webhooks", webhookRoutes);

// Payment (webhook + checkout page are public, subscribe/cancel require auth)
api.route("/payment", paymentRoutes);

// Admin (requires admin role)
api.route("/admin", admin);

// Search (optional auth — works for both authenticated and unauthenticated users)
api.route("/search", searchRoutes);

// Public API (requires auth)
api.route("/events", eventRoutes);
api.route("/groups", groupRoutes);
api.route("/content", contentRoutes);
api.route("/media", mediaRoutes);
api.route("/users", userRoutes);
api.route("/download-requests", downloadsRoutes);
api.route("/publications", publicationRoutes);
api.route("/teachers", teacherRoutes);
api.route("/sync", syncRoutes);

// Test-only routes — never mounted in production
if (config.nodeEnv !== "production") {
  api.route("/test", testRoutes);
}

export { api };
