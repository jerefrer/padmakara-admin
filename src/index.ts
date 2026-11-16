import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { config } from "./config.ts";
import { errorHandler } from "./lib/errors.ts";
import { api } from "./routes/index.ts";
import { startUsagePruning } from "./services/usage.ts";
import { startMembershipReconcile } from "./services/membership-reconcile.ts";

const app = new Hono();

// Global middleware
app.use("*", logger());
// CORP defaults to "same-origin", which blocks the web app (app.padmakara.pt)
// from loading media served by the API (api.padmakara.pt) — hls.js fetches the
// HLS playlist/segments cross-origin and the browser rejects it with
// ERR_BLOCKED_BY_RESPONSE.NotSameOrigin. Access is gated by JWT/MAT, not CORP,
// so allow cross-origin embedding of API resources.
app.use("*", secureHeaders({ crossOriginResourcePolicy: "cross-origin" }));
app.use(
  "/api/*",
  cors({
    origin: [
      config.urls.frontend,
      config.urls.admin,
      "tauri://localhost", // Tauri desktop app
    ],
    credentials: true,
  }),
);
// Bound how much a request body can make the server buffer. Public routes only ever
// receive small JSON (webhooks, progress, sign-in); the payment webhook sets a
// tighter limit of its own. Admin routes take image and CSV uploads, so they get a
// larger cap; audio, video and PDFs never pass through here (presigned to storage).
const PUBLIC_BODY_LIMIT_BYTES = 1024 * 1024;
const ADMIN_BODY_LIMIT_BYTES = 50 * 1024 * 1024;
const tooLarge = (c: Context) =>
  c.json({ error: "Request body too large", code: "PAYLOAD_TOO_LARGE" }, 413);
const publicBodyLimit = bodyLimit({ maxSize: PUBLIC_BODY_LIMIT_BYTES, onError: tooLarge });
const adminBodyLimit = bodyLimit({ maxSize: ADMIN_BODY_LIMIT_BYTES, onError: tooLarge });
app.use("/api/*", (c, next) =>
  c.req.path.startsWith("/api/admin/") ? adminBodyLimit(c, next) : publicBodyLimit(c, next),
);
// Strip trailing slashes by forwarding internally (no redirect).
// React Native on iOS doesn't reliably follow 308 redirects for POST,
// so we rewrite the request URL and re-dispatch through the router.
app.use("/api/*", async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
    const newReq = new Request(url.toString(), c.req.raw);
    return app.fetch(newReq, c.env);
  }
  await next();
});

// Health check
app.get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);

// API routes
app.route("/api", api);

// Error handler
app.onError(errorHandler);

// 404 handler
app.notFound((c) =>
  c.json({ error: "Not found", code: "NOT_FOUND" }, 404),
);

// Daily activity rows are kept 13 months, then deleted
if (process.env.NODE_ENV !== "test") startUsagePruning();

// Membership captures a notification missed are credited from Easypay every hour
if (process.env.NODE_ENV !== "test") startMembershipReconcile();

export default {
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 120,
};

export { app };
