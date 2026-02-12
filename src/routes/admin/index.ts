import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth.ts";
import { adminMiddleware } from "../../middleware/admin.ts";
import { teacherRoutes } from "./teachers.ts";
import { placeRoutes } from "./places.ts";
import { groupRoutes } from "./groups.ts";
import { retreatRoutes } from "./retreats.ts";
import { sessionRoutes } from "./sessions.ts";
import { trackRoutes } from "./tracks.ts";
import { userRoutes } from "./users.ts";
import { uploadRoutes } from "./upload.ts";

const admin = new Hono();

// All admin routes require authentication + admin role
admin.use("*", authMiddleware, adminMiddleware);

admin.route("/teachers", teacherRoutes);
admin.route("/places", placeRoutes);
admin.route("/groups", groupRoutes);
admin.route("/retreats", retreatRoutes);
admin.route("/sessions", sessionRoutes);
admin.route("/tracks", trackRoutes);
admin.route("/users", userRoutes);
admin.route("/upload", uploadRoutes);

export { admin };
