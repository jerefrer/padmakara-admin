import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testRequest, testJson } from "../../helpers.ts";

// ─── Mocks (must come before route imports) ──────────────────────────────

vi.mock("../../../src/db/index.ts", () => {
  const teacherFindFirst = vi.fn();
  const groupFindFirst = vi.fn();
  return {
    db: {
      query: {
        teachers: { findFirst: teacherFindFirst },
        retreatGroups: { findFirst: groupFindFirst },
      },
      _teacherFindFirst: teacherFindFirst,
      _groupFindFirst: groupFindFirst,
    },
  };
});

vi.mock("../../../src/services/s3.ts", () => ({
  getObjectBytes: vi.fn(),
  // touched by the module's other routes at import time
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  buildTeacherAvatarS3Key: vi.fn(),
  buildTeacherHeroS3Key: vi.fn(),
  buildTeacherHeroMobileS3Key: vi.fn(),
  buildGroupAvatarS3Key: vi.fn(),
  buildGroupHeroS3Key: vi.fn(),
  buildGroupHeroMobileS3Key: vi.fn(),
}));

vi.mock("../../../src/services/image-pipeline.ts", () => ({
  processAvatar: vi.fn(),
  processHero: vi.fn(),
  processHeroMobile: vi.fn(),
}));

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
  bumpUserAccessVersion: vi.fn(() => Promise.resolve()),
}));

import { db } from "../../../src/db/index.ts";
import { getObjectBytes } from "../../../src/services/s3.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const teacherFindFirst = (db as any)._teacherFindFirst as ReturnType<typeof vi.fn>;
const groupFindFirst = (db as any)._groupFindFirst as ReturnType<typeof vi.fn>;
const mockGetObjectBytes = getObjectBytes as ReturnType<typeof vi.fn>;

const adminToken = () =>
  createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
const userToken = () =>
  createAccessToken({ sub: 2, email: "user@test.com", role: "user" });

const auth = async () => ({ Authorization: `Bearer ${await adminToken()}` });

describe("admin image source endpoints", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe("GET /api/admin/teachers/:id/avatar/source", () => {
    it("streams the stored object when the teacher has an S3 avatar", async () => {
      teacherFindFirst.mockResolvedValueOnce({
        id: 5,
        avatarS3Key: "teachers/avatars/5-123.webp",
        photoUrl: null,
      });
      mockGetObjectBytes.mockResolvedValueOnce({
        body: new Uint8Array([1, 2, 3, 4]),
        contentType: "image/webp",
      });

      const res = await testRequest("/api/admin/teachers/5/avatar/source", {
        headers: await auth(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3, 4]),
      );
      expect(mockGetObjectBytes).toHaveBeenCalledWith("teachers/avatars/5-123.webp");
    });

    // The bug this endpoint exists for: legacy avatars live on third-party
    // hosts that send no CORS headers, so the browser cannot read them.
    it("fetches the legacy external photoUrl server-side when there is no S3 key", async () => {
      teacherFindFirst.mockResolvedValueOnce({
        id: 6,
        avatarS3Key: null,
        photoUrl: "https://www.khyentsevision.org/wp-content/uploads/x.jpg",
      });
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(new Uint8Array([9, 9]), {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          }),
        ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const res = await testRequest("/api/admin/teachers/6/avatar/source", {
        headers: await auth(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String((fetchMock.mock.calls[0] as any[])[0])).toBe(
        "https://www.khyentsevision.org/wp-content/uploads/x.jpg",
      );
      expect(mockGetObjectBytes).not.toHaveBeenCalled();
    });

    it("returns 502 when the legacy host answers with an error", async () => {
      teacherFindFirst.mockResolvedValueOnce({
        id: 6,
        avatarS3Key: null,
        photoUrl: "https://example.com/gone.jpg",
      });
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response("", { status: 404 })),
      ) as unknown as typeof fetch;

      const { status, body } = await testJson("/api/admin/teachers/6/avatar/source", {
        headers: await auth(),
      });

      expect(status).toBe(502);
      expect(body.code).toBe("IMAGE_SOURCE_UNAVAILABLE");
    });

    it("refuses to fetch a stored URL pointing at a private host", async () => {
      teacherFindFirst.mockResolvedValueOnce({
        id: 7,
        avatarS3Key: null,
        photoUrl: "http://169.254.169.254/latest/meta-data/",
      });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { status, body } = await testJson("/api/admin/teachers/7/avatar/source", {
        headers: await auth(),
      });

      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_IMAGE_URL");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns 404 when the teacher has no avatar at all", async () => {
      teacherFindFirst.mockResolvedValueOnce({ id: 8, avatarS3Key: null, photoUrl: null });

      const { status } = await testJson("/api/admin/teachers/8/avatar/source", {
        headers: await auth(),
      });

      expect(status).toBe(404);
    });

    it("returns 404 when the teacher does not exist", async () => {
      teacherFindFirst.mockResolvedValueOnce(undefined);

      const { status } = await testJson("/api/admin/teachers/999/avatar/source", {
        headers: await auth(),
      });

      expect(status).toBe(404);
    });

    it("requires authentication", async () => {
      const res = await testRequest("/api/admin/teachers/5/avatar/source");
      expect(res.status).toBe(401);
    });

    it("requires an admin role", async () => {
      const res = await testRequest("/api/admin/teachers/5/avatar/source", {
        headers: { Authorization: `Bearer ${await userToken()}` },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/admin/teachers/:id/hero/source", () => {
    it("streams the stored hero", async () => {
      teacherFindFirst.mockResolvedValueOnce({
        id: 5,
        heroS3Key: "teachers/heroes/5-123.webp",
      });
      mockGetObjectBytes.mockResolvedValueOnce({
        body: new Uint8Array([7]),
        contentType: "image/webp",
      });

      const res = await testRequest("/api/admin/teachers/5/hero/source", {
        headers: await auth(),
      });

      expect(res.status).toBe(200);
      expect(mockGetObjectBytes).toHaveBeenCalledWith("teachers/heroes/5-123.webp");
    });

    it("returns 404 when the teacher has no hero", async () => {
      teacherFindFirst.mockResolvedValueOnce({ id: 5, heroS3Key: null });

      const { status } = await testJson("/api/admin/teachers/5/hero/source", {
        headers: await auth(),
      });

      expect(status).toBe(404);
    });
  });

  describe("group image sources", () => {
    it("streams the stored group avatar", async () => {
      groupFindFirst.mockResolvedValueOnce({
        id: 12,
        avatarS3Key: "groups/avatars/12-123.webp",
        logoUrl: null,
      });
      mockGetObjectBytes.mockResolvedValueOnce({
        body: new Uint8Array([3]),
        contentType: "image/webp",
      });

      const res = await testRequest("/api/admin/groups/12/avatar/source", {
        headers: await auth(),
      });

      expect(res.status).toBe(200);
      expect(mockGetObjectBytes).toHaveBeenCalledWith("groups/avatars/12-123.webp");
    });

    it("falls back to the legacy logoUrl", async () => {
      groupFindFirst.mockResolvedValueOnce({
        id: 12,
        avatarS3Key: null,
        logoUrl: "https://example.com/logo.png",
      });
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(new Uint8Array([4]), {
            status: 200,
            headers: { "Content-Type": "image/png" },
          }),
        ),
      ) as unknown as typeof fetch;

      const res = await testRequest("/api/admin/groups/12/avatar/source", {
        headers: await auth(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    });

    it("streams the stored group hero", async () => {
      groupFindFirst.mockResolvedValueOnce({
        id: 12,
        heroS3Key: "groups/heroes/12-123.webp",
      });
      mockGetObjectBytes.mockResolvedValueOnce({
        body: new Uint8Array([5]),
        contentType: "image/webp",
      });

      const res = await testRequest("/api/admin/groups/12/hero/source", {
        headers: await auth(),
      });

      expect(res.status).toBe(200);
      expect(mockGetObjectBytes).toHaveBeenCalledWith("groups/heroes/12-123.webp");
    });

    it("returns 404 for a missing group", async () => {
      groupFindFirst.mockResolvedValueOnce(undefined);

      const { status } = await testJson("/api/admin/groups/999/avatar/source", {
        headers: await auth(),
      });

      expect(status).toBe(404);
    });
  });
});
