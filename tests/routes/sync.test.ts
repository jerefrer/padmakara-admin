import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/sync-versions.ts", () => ({
  getAllVersions: vi.fn(),
  getUserVersion: vi.fn(),
}));

vi.mock("../../src/middleware/auth.ts", () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set("user", { id: 1, email: "test@test.com", role: "user" });
    await next();
  },
  getUser: (c: any) => c.get("user"),
}));

import { syncRoutes } from "../../src/routes/sync.ts";
import { getAllVersions, getUserVersion } from "../../src/services/sync-versions.ts";
import { Hono } from "hono";

function buildApp() {
  const app = new Hono();
  app.route("/sync", syncRoutes);
  return app;
}

describe("GET /sync/versions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns per-namespace {global, user} tuples", async () => {
    (getAllVersions as any).mockResolvedValue({
      events: 42,
      groups: 7,
      publications: 23,
      teachers: 17,
    });
    (getUserVersion as any).mockResolvedValue(5);

    const app = buildApp();
    const res = await app.request("/sync/versions");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      events:       { global: 42, user: 5 },
      groups:       { global: 7,  user: 5 },
      publications: { global: 23, user: 5 },
      teachers:     { global: 17, user: 5 },
    });
  });

  it("uses the authenticated user id when fetching user version", async () => {
    (getAllVersions as any).mockResolvedValue({ events: 1 });
    (getUserVersion as any).mockResolvedValue(3);

    const app = buildApp();
    await app.request("/sync/versions");

    // The mocked auth sets user.id = 1
    expect(getUserVersion).toHaveBeenCalledWith(1);
  });

  it("returns 200 with empty object if no global versions exist", async () => {
    (getAllVersions as any).mockResolvedValue({});
    (getUserVersion as any).mockResolvedValue(0);

    const app = buildApp();
    const res = await app.request("/sync/versions");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("user version defaults to 0 for users with no admin-changed access", async () => {
    (getAllVersions as any).mockResolvedValue({ events: 10 });
    (getUserVersion as any).mockResolvedValue(0);

    const app = buildApp();
    const res = await app.request("/sync/versions");
    const body = await res.json() as Record<string, unknown>;

    expect(body.events).toEqual({ global: 10, user: 0 });
  });
});
