import { Hono } from "hono";
import { auth } from "./auth.ts";
import { admin } from "./admin/index.ts";
import { retreatRoutes } from "./retreats.ts";
import { groupRoutes } from "./groups.ts";
import { contentRoutes } from "./content.ts";
import { mediaRoutes } from "./media.ts";
import { userRoutes } from "./users.ts";

const api = new Hono();

// Auth (public endpoints)
api.route("/auth", auth);

// Admin (requires admin role)
api.route("/admin", admin);

// Public API (requires auth)
api.route("/retreats", retreatRoutes);
api.route("/groups", groupRoutes);
api.route("/content", contentRoutes);
api.route("/media", mediaRoutes);
api.route("/users", userRoutes);

export { api };
