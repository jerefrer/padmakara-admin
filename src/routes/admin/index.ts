import { Hono } from "hono";
import { authMiddleware } from "../../middleware/auth.ts";
import { adminMiddleware } from "../../middleware/admin.ts";
import { teacherRoutes } from "./teachers.ts";
import { placeRoutes } from "./places.ts";
import { groupRoutes } from "./groups.ts";
import { eventRoutes } from "./events.ts";
import { eventTypeRoutes } from "./event-types.ts";
import { audienceRoutes } from "./audiences.ts";
import { sessionRoutes } from "./sessions.ts";
import { videoRoutes } from "./videos.ts";
import { eventFileRoutes } from "./event-files.ts";
import { trackRoutes } from "./tracks.ts";
import { userRoutes } from "./users.ts";
import { approvalRoutes } from "./approvals.ts";
import { uploadRoutes } from "./upload.ts";
import { publicationRoutes } from "./publications.ts";
import { analyzeRoutes } from "./import/analyze.ts";
import { translateRoutes } from "./translate.ts";
import { TRANSLATION_MODELS, DEFAULT_TRANSLATE_MODEL } from "../../services/translation-models.ts";

const admin = new Hono();

// All admin routes require authentication + admin role
admin.use("*", authMiddleware, adminMiddleware);

admin.get("/translation-models", (c) =>
  c.json({ models: TRANSLATION_MODELS, default: DEFAULT_TRANSLATE_MODEL }),
);

admin.route("/teachers", teacherRoutes);
admin.route("/places", placeRoutes);
admin.route("/groups", groupRoutes);
admin.route("/events", eventRoutes);
admin.route("/event-types", eventTypeRoutes);
admin.route("/audiences", audienceRoutes);
admin.route("/sessions", sessionRoutes);
admin.route("/videos", videoRoutes);
admin.route("/event-files", eventFileRoutes);
admin.route("/tracks", trackRoutes);
admin.route("/translate", translateRoutes);
admin.route("/users", userRoutes);
admin.route("/approvals", approvalRoutes);
admin.route("/upload", uploadRoutes);
admin.route("/publications", publicationRoutes);
admin.route("/import/analyze", analyzeRoutes);

export { admin };
