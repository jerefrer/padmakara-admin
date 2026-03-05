import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config.ts";
import { errorHandler } from "./lib/errors.ts";
import { api } from "./routes/index.ts";

const app = new Hono();

// Global middleware
app.use("*", logger());
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

export default {
  port: config.port,
  fetch: app.fetch,
  idleTimeout: 120,
};

export { app };
