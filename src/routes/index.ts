import { Hono } from "hono";
import { config } from "../config.ts";
import { auth } from "./auth.ts";
import { passkeyRoutes } from "./passkeys.ts";
import { admin } from "./admin/index.ts";
import { emailAssetRoutes } from "./email-assets.ts";
import { eventRoutes } from "./events.ts";
import { eventArtworkRoutes } from "./event-artwork.ts";
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
import { teacherArtworkRoutes } from "./teacher-artwork.ts";
import { teachingRoutes } from "./teachings.ts";
import { testRoutes } from "./test.ts";

const api = new Hono();

// Auth (public endpoints)
api.route("/auth", auth);
api.route("/auth/passkeys", passkeyRoutes);

// Webhooks (public, HMAC-authenticated)
api.route("/webhooks", webhookRoutes);

// Payment (webhook + checkout page are public, subscribe/cancel require auth)
api.route("/payment", paymentRoutes);

// Images the emails point at (public: they load from an inbox, unauthenticated)
api.route("/email-assets", emailAssetRoutes);

// Admin (requires admin role)
api.route("/admin", admin);

// Search (optional auth — works for both authenticated and unauthenticated users)
api.route("/search", searchRoutes);

// Square event-photo artwork for the lock screen (public: the OS fetches it, mounted before the authed router)
api.route("/events", eventArtworkRoutes);

// Public API (requires auth)
api.route("/events", eventRoutes);
api.route("/groups", groupRoutes);
api.route("/content", contentRoutes);
api.route("/media", mediaRoutes);
api.route("/users", userRoutes);
api.route("/download-requests", downloadsRoutes);
api.route("/publications", publicationRoutes);
// Square speaker artwork for the lock screen (public: the OS fetches it, mounted before the authed router)
api.route("/teachers", teacherArtworkRoutes);
api.route("/teachers", teacherRoutes);
// Single teachings: public sale page + checkout; /mine needs auth (set per route)
api.route("/teachings", teachingRoutes);
api.route("/sync", syncRoutes);

// Test-only routes: they mint a token for any user id and role. Mounted only for the
// test suites (NODE_ENV=test) or an explicit E2E_ENABLED=true, never in production
// whatever the flag says, and not on a dev or staging server left at the defaults.
if (config.nodeEnv !== "production" && (config.nodeEnv === "test" || config.e2eEnabled)) {
  api.route("/test", testRoutes);
}

export { api };
