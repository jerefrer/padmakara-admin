import { Hono } from "hono";
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

const api = new Hono();

// Auth (public endpoints)
api.route("/auth", auth);

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

export { api };
