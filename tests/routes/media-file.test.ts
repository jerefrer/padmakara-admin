import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson, testRequest } from "../helpers.ts";

const findFirst = vi.fn();

vi.mock("../../src/db/index.ts", () => ({
  db: { query: {
    eventFiles: { findFirst: (...a: any[]) => findFirst(...a) },
    users: { findFirst: vi.fn(() => Promise.resolve({ id: 1, firstName: "Ann", lastName: "Lee" })) },
  } },
}));

vi.mock("../../src/services/access.ts", () => ({
  checkEventAccess: vi.fn(() => Promise.resolve({ allowed: true })),
  denialToHttpError: vi.fn(() => { throw new Error("denied"); }),
}));

vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3/get")),
  generatePresignedAttachmentUrl: vi.fn(() => Promise.resolve("https://s3/get?attach")),
  getObjectText: vi.fn(),
}));

import { createAccessToken } from "../../src/services/auth.ts";
const userToken = () => createAccessToken({ sub: 1, email: "u@test.com", role: "user" });

describe("GET /api/media/file/:id", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("401 without auth", async () => {
    // No findFirst mock queued here: the route checks auth before touching the
    // DB, so this never reaches eventFiles.findFirst. Queuing an unconsumed
    // mockResolvedValueOnce would leak into the next test's queue, since
    // vi.clearAllMocks() clears call history but not pending "Once" values.
    const { status } = await testJson("/api/media/file/5");
    expect(status).toBe(401);
  });

  it("redirects a non-sensitive image to a presigned URL", async () => {
    findFirst.mockResolvedValueOnce({ id: 5, eventId: 3, extension: "png", sensitive: false, s3Key: "events/E/image/p.png", originalFilename: "p.png", event: { id: 3, audience: null } });
    const token = await userToken();
    // testJson always calls res.json(), which throws on a 302's empty body.
    // This call never leaves the process (app.fetch() invokes Hono's router
    // directly), so there's no real HTTP client to follow the redirect —
    // inspect the raw Response instead to assert on status + Location.
    const res = await testRequest("/api/media/file/5", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([301, 302]).toContain(res.status);
    expect(res.headers.get("location")).toBe("https://s3/get");
  });

  it("404 for a missing file", async () => {
    findFirst.mockResolvedValueOnce(null);
    const token = await userToken();
    const { status } = await testJson("/api/media/file/999", { headers: { Authorization: `Bearer ${token}` } });
    expect(status).toBe(404);
  });
});
