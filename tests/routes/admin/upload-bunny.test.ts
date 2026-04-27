import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testJson } from "../../helpers.ts";

// Mock the bunny service so the admin endpoints don't actually call Bunny.
vi.mock("../../../src/services/bunny.ts", () => ({
  createVideo: vi.fn(),
  deleteVideo: vi.fn(),
  getVideoMeta: vi.fn(),
  buildTusCredentials: vi.fn(),
}));

// db is referenced indirectly via auth/admin middleware paths — mock minimally.
vi.mock("../../../src/db/index.ts", () => ({
  db: {
    query: { users: { findFirst: vi.fn() } },
    select: vi.fn(),
  },
}));

import { createAccessToken } from "../../../src/services/auth.ts";
import {
  createVideo,
  deleteVideo,
  getVideoMeta,
  buildTusCredentials,
} from "../../../src/services/bunny.ts";

const mockCreateVideo = createVideo as ReturnType<typeof vi.fn>;
const mockDeleteVideo = deleteVideo as ReturnType<typeof vi.fn>;
const mockGetVideoMeta = getVideoMeta as ReturnType<typeof vi.fn>;
const mockBuildTusCredentials = buildTusCredentials as ReturnType<typeof vi.fn>;

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

describe("admin upload — Bunny endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/admin/upload/bunny/create", () => {
    it("creates a Bunny video and returns TUS credentials", async () => {
      mockCreateVideo.mockResolvedValueOnce({ guid: "vid-guid-123" });
      mockBuildTusCredentials.mockReturnValueOnce({
        endpoint: "https://video.bunnycdn.com/tusupload",
        videoId: "vid-guid-123",
        libraryId: "12345",
        signature: "deadbeef",
        expirationTime: 1800000000,
      });

      const token = await adminToken();
      const { status, body } = await testJson("/api/admin/upload/bunny/create", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: "Day 1 Morning" }),
      });

      expect(status).toBe(200);
      expect(body).toEqual({
        endpoint: "https://video.bunnycdn.com/tusupload",
        videoId: "vid-guid-123",
        libraryId: "12345",
        signature: "deadbeef",
        expirationTime: 1800000000,
      });
      expect(mockCreateVideo).toHaveBeenCalledWith("Day 1 Morning");
      expect(mockBuildTusCredentials).toHaveBeenCalledWith("vid-guid-123");
    });

    it("returns 400 when title is missing", async () => {
      const token = await adminToken();
      const { status } = await testJson("/api/admin/upload/bunny/create", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });

      expect(status).toBe(400);
      expect(mockCreateVideo).not.toHaveBeenCalled();
    });

    it("returns 400 when title is empty/whitespace", async () => {
      const token = await adminToken();
      const { status } = await testJson("/api/admin/upload/bunny/create", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: "   " }),
      });

      expect(status).toBe(400);
    });

    it("returns 401 without an auth token", async () => {
      const { status } = await testJson("/api/admin/upload/bunny/create", {
        method: "POST",
        body: JSON.stringify({ title: "Morning" }),
      });

      expect(status).toBe(401);
    });

    it("returns 403 for non-admin users", async () => {
      const token = await createAccessToken({ sub: 2, email: "user@test.com", role: "user" });
      const { status } = await testJson("/api/admin/upload/bunny/create", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: "Morning" }),
      });

      expect(status).toBe(403);
    });
  });

  describe("GET /api/admin/upload/bunny/:videoId", () => {
    it("returns the video's transcoding status and metadata", async () => {
      mockGetVideoMeta.mockResolvedValueOnce({
        guid: "vid-guid-123",
        title: "Day 1 Morning",
        status: 4,
        length: 5400,
        width: 1920,
        height: 1080,
        framerate: 30,
        thumbnailFileName: "thumbnail.jpg",
        availableResolutions: "240p,360p,480p,720p,1080p",
      });

      const token = await adminToken();
      const { status, body } = await testJson("/api/admin/upload/bunny/vid-guid-123", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({
        guid: "vid-guid-123",
        status: 4,
        durationSeconds: 5400,
        width: 1920,
        height: 1080,
        thumbnailFileName: "thumbnail.jpg",
      });
    });

    it("requires admin auth", async () => {
      const { status } = await testJson("/api/admin/upload/bunny/vid-guid-123");
      expect(status).toBe(401);
    });
  });

  describe("DELETE /api/admin/upload/bunny/:videoId", () => {
    it("deletes a Bunny video", async () => {
      mockDeleteVideo.mockResolvedValueOnce(undefined);

      const token = await adminToken();
      const { status, body } = await testJson("/api/admin/upload/bunny/vid-guid-123", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(mockDeleteVideo).toHaveBeenCalledWith("vid-guid-123");
    });

    it("requires admin auth", async () => {
      const { status } = await testJson("/api/admin/upload/bunny/vid-guid-123", {
        method: "DELETE",
      });
      expect(status).toBe(401);
    });
  });
});
