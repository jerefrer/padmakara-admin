import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { config } from "./config.ts";
import { errorHandler } from "./lib/errors.ts";
import { api } from "./routes/index.ts";

const app = new Hono();

// Global middleware
app.use("*", logger());
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

// Admin SPA — serve static assets, fall back to index.html for client-side routing
app.use("/admin/*", serveStatic({ root: "./admin/dist", rewriteRequestPath: (path) => path.replace(/^\/admin/, "") }));
app.get("/admin/*", serveStatic({ root: "./admin/dist", path: "index.html" }));

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
