import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { trimTrailingSlash } from "hono/trailing-slash";
import { serveStatic } from "hono/bun";
import { config } from "./config.ts";
import { errorHandler } from "./lib/errors.ts";
import { api } from "./routes/index.ts";

const app = new Hono();

// Global middleware
app.use("*", logger());
// Strip trailing slashes on API routes (React Native app sends them)
app.use("/api/*", trimTrailingSlash());
app.use(
  "/api/*",
  cors({
    origin: [config.urls.frontend, config.urls.admin],
    credentials: true,
  }),
);

// Health check
app.get("/health", (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);

// API routes
app.route("/api", api);

// Admin SPA — redirect /admin to /admin/
app.get("/admin", (c) => c.redirect("/admin/"));

// Serve static assets from admin/dist, stripping the /admin prefix
app.use(
  "/admin/*",
  serveStatic({
    root: "./admin/dist",
    rewriteRequestPath: (path) => path.replace(/^\/admin/, ""),
  }),
);

// SPA fallback — serve index.html for any unmatched /admin/* route (client-side routing)
app.get("/admin/*", async (c) => {
  const html = await Bun.file("./admin/dist/index.html").text();
  return c.html(html);
});

// Error handler
app.onError(errorHandler);

// 404 handler
app.notFound((c) =>
  c.json({ error: "Not found", code: "NOT_FOUND" }, 404),
);

export default {
  port: config.port,
  fetch: app.fetch,
};

export { app };
