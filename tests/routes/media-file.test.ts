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
import { checkEventAccess, denialToHttpError } from "../../src/services/access.ts";
import { AppError } from "../../src/lib/errors.ts";
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

  it("streams a non-sensitive file through the API (no S3 redirect)", async () => {
    findFirst.mockResolvedValueOnce({ id: 5, eventId: 3, extension: "png", sensitive: false, s3Key: "events/E/image/p.png", originalFilename: "p.png", event: { id: 3, audience: null } });
    // The route now fetches the presigned S3 URL server-side and pipes the body
    // back on our own origin (so the web app can fetch()+blob it without S3
    // CORS). Stub global fetch to stand in for the S3 GET.
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": "3" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const token = await userToken();
      const res = await testRequest("/api/media/file/5", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      // Streamed through our origin — did NOT redirect to S3.
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("content-disposition")).toContain("inline");
      const body = new Uint8Array(await res.arrayBuffer());
      expect(Array.from(body)).toEqual([1, 2, 3]);
      // We fetched the presigned URL, not the raw s3Key.
      expect(fetchMock).toHaveBeenCalledWith("https://s3/get");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("404 for a missing file", async () => {
    findFirst.mockResolvedValueOnce(null);
    const token = await userToken();
    const { status } = await testJson("/api/media/file/999", { headers: { Authorization: `Bearer ${token}` } });
    expect(status).toBe(404);
  });

  it("403 when checkEventAccess denies access", async () => {
    findFirst.mockResolvedValueOnce({ id: 5, eventId: 3, extension: "pdf", sensitive: false, s3Key: "events/E/file/doc.pdf", originalFilename: "doc.pdf", event: { id: 3, audience: { slug: "free-subscribers" } } });
    // Override the module-level always-allow mocks for this test only: deny
    // access and have denialToHttpError map the denial to a real 403 AppError,
    // matching how the route's `if (!accessResult.allowed) denialToHttpError(...)`
    // call behaves against the real access service.
    vi.mocked(checkEventAccess).mockResolvedValueOnce({ allowed: false, reason: "SUBSCRIPTION_REQUIRED" });
    vi.mocked(denialToHttpError).mockImplementationOnce(() => {
      throw AppError.forbidden("Active subscription required");
    });
    const token = await userToken();
    const { status } = await testJson("/api/media/file/5", { headers: { Authorization: `Bearer ${token}` } });
    expect(status).toBe(403);
  });
});
