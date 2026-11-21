import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockSet, mockReturning } = vi.hoisted(() => {
  const returning = vi.fn();
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  return {
    mockReturning: returning,
    mockSet: set,
    mockDb: { query: { events: { findFirst: vi.fn() } }, update: vi.fn(() => ({ set })) },
  };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
  bumpVersions: vi.fn(() => Promise.resolve()),
  bumpUserAccessVersion: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../src/services/s3.ts", () => ({
  putObject: vi.fn(() => Promise.resolve()),
  deleteObject: vi.fn(() => Promise.resolve()),
  generatePresignedDownloadUrl: vi.fn((key: string) => Promise.resolve(`https://signed/${key}`)),
  buildEventAvatarS3Key: vi.fn((code: string) => `events/${code}/images/avatar-new.webp`),
  buildEventHeroS3Key: vi.fn((code: string) => `events/${code}/images/hero-new.webp`),
  buildEventHeroMobileS3Key: vi.fn((code: string) => `events/${code}/images/hero-new-m.webp`),
  buildEventHeroOriginalS3Key: vi.fn((code: string, ext: string) => `events/${code}/images/originals/new.${ext}`),
}));
vi.mock("../../../src/services/image-pipeline.ts", () => ({
  processAvatar: vi.fn(() => Promise.resolve(Buffer.from("AVATAR"))),
  processAvatarFromHero: vi.fn(() => Promise.resolve(Buffer.from("AVATAR_FROM_HERO"))),
  processHero: vi.fn(() => Promise.resolve(Buffer.from("HERO_DESKTOP"))),
  processHeroMobile: vi.fn(() => Promise.resolve(Buffer.from("HERO_MOBILE"))),
}));

import { app } from "../../../src/index.ts";
import { putObject, deleteObject } from "../../../src/services/s3.ts";
import { processAvatarFromHero } from "../../../src/services/image-pipeline.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const CODE = "2026.05.01 - HK";
const OVERRIDES = { page: { focalX: 10, focalY: 20, zoom: 1.5 } };

async function adminHeaders() {
  const token = await createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
  return { Authorization: `Bearer ${token}` };
}

function form(fields: Record<string, string> = {}, withFile = true) {
  const f = new FormData();
  if (withFile) f.append("file", new File(["RAW"], "photo.jpg", { type: "image/jpeg" }));
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

async function post(path: string, body: FormData, headers: Record<string, string>) {
  const res = await app.fetch(new Request(new URL(path, "http://localhost").toString(), { method: "POST", headers, body }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("event photo admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.events.findFirst.mockResolvedValue({ id: 5, eventCode: CODE, storagePrefix: CODE });
    mockReturning.mockResolvedValue([{ id: 5, eventCode: CODE, heroS3Key: `events/${CODE}/images/hero-new.webp` }]);
  });

  describe("POST /api/admin/events/:id/hero", () => {
    it("should store new photos under the fixed storage folder when the event code has changed", async () => {
      mockDb.query.events.findFirst.mockResolvedValue({ id: 5, eventCode: "NEW-CODE", storagePrefix: "OLD-FOLDER" });
      await post("/api/admin/events/5/hero", form(), await adminHeaders());
      expect(putObject).toHaveBeenCalledWith("events/OLD-FOLDER/images/hero-new.webp", expect.any(Buffer), "image/webp");
    });

    it("should write the desktop, mobile and derived avatar variants under the event prefix", async () => {
      const { status, body } = await post("/api/admin/events/5/hero", form({ focalX: "30", focalY: "40" }), await adminHeaders());
      expect(status).toBe(200);
      expect(putObject).toHaveBeenCalledWith(`events/${CODE}/images/hero-new.webp`, Buffer.from("HERO_DESKTOP"), "image/webp");
      expect(putObject).toHaveBeenCalledWith(`events/${CODE}/images/hero-new-m.webp`, Buffer.from("HERO_MOBILE"), "image/webp");
      expect(putObject).toHaveBeenCalledWith(`events/${CODE}/images/avatar-new.webp`, Buffer.from("AVATAR_FROM_HERO"), "image/webp");
      expect(processAvatarFromHero).toHaveBeenCalledWith(expect.any(Buffer), { x: 30, y: 40 });
      expect(body.heroUrl).toBe(`https://signed/events/${CODE}/images/hero-new.webp`);
    });

    it("should persist focal point, full scale and timestamps", async () => {
      await post("/api/admin/events/5/hero", form({ focalX: "130", focalY: "-5" }), await adminHeaders());
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ heroFocalX: 100, heroFocalY: 0, heroScale: 100, heroUpdatedAt: expect.any(Date), avatarUpdatedAt: expect.any(Date) }),
      );
    });

    it("should delete the previous variants when they sit at other keys", async () => {
      mockDb.query.events.findFirst.mockResolvedValue({
        id: 5, eventCode: CODE, storagePrefix: CODE, heroS3Key: "old-h", heroMobileS3Key: "old-m", avatarS3Key: "old-a",
      });
      await post("/api/admin/events/5/hero", form(), await adminHeaders());
      expect(deleteObject).toHaveBeenCalledWith("old-h");
      expect(deleteObject).toHaveBeenCalledWith("old-m");
      expect(deleteObject).toHaveBeenCalledWith("old-a");
    });

    it("should keep the original and crop sent with the upload", async () => {
      const f = form({ crop: JSON.stringify({ x: 1, y: 2, width: 30, height: 40 }), grayscale: "true" });
      f.append("original", new File(["BIG"], "big.png", { type: "image/png" }));
      await post("/api/admin/events/5/hero", f, await adminHeaders());
      expect(putObject).toHaveBeenCalledWith(`events/${CODE}/images/originals/new.png`, expect.any(Buffer), "image/png");
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          heroOriginalS3Key: `events/${CODE}/images/originals/new.png`,
          heroCrop: { x: 1, y: 2, width: 30, height: 40 },
          heroGrayscale: true,
        }),
      );
    });

    it("should store the frame overrides sent with the upload", async () => {
      await post("/api/admin/events/5/hero", form({ frameOverrides: JSON.stringify(OVERRIDES) }), await adminHeaders());
      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ heroFrameOverrides: OVERRIDES }));
    });

    it("should clear the frame overrides when the upload sends none", async () => {
      mockDb.query.events.findFirst.mockResolvedValue({ id: 5, eventCode: CODE, storagePrefix: CODE, heroFrameOverrides: OVERRIDES });
      await post("/api/admin/events/5/hero", form(), await adminHeaders());
      expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ heroFrameOverrides: null }));
    });

    it("should reject overrides with an unknown frame key", async () => {
      const { status } = await post("/api/admin/events/5/hero", form({ frameOverrides: JSON.stringify({ tablet: OVERRIDES.page }) }), await adminHeaders());
      expect(status).toBe(400);
      expect(mockSet).not.toHaveBeenCalled();
    });

    it("should return 400 when no file is sent", async () => {
      const { status } = await post("/api/admin/events/5/hero", form({}, false), await adminHeaders());
      expect(status).toBe(400);
    });

    it("should return 404 when the event does not exist", async () => {
      mockDb.query.events.findFirst.mockResolvedValue(undefined);
      const { status } = await post("/api/admin/events/99/hero", form(), await adminHeaders());
      expect(status).toBe(404);
    });

    it("should return 401 without a token", async () => {
      const { status } = await post("/api/admin/events/5/hero", form(), {});
      expect(status).toBe(401);
    });

    it("should return 403 for a non-admin", async () => {
      const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
      const { status } = await post("/api/admin/events/5/hero", form(), { Authorization: `Bearer ${token}` });
      expect(status).toBe(403);
    });
  });

  describe("POST /api/admin/events/:id/avatar", () => {
    it("should resize, store under the event prefix and replace the previous avatar", async () => {
      mockDb.query.events.findFirst.mockResolvedValue({ id: 5, eventCode: CODE, storagePrefix: CODE, avatarS3Key: "old-a" });
      mockReturning.mockResolvedValue([{ id: 5, avatarS3Key: `events/${CODE}/images/avatar-new.webp` }]);
      const { status, body } = await post("/api/admin/events/5/avatar", form(), await adminHeaders());
      expect(status).toBe(200);
      expect(putObject).toHaveBeenCalledWith(`events/${CODE}/images/avatar-new.webp`, Buffer.from("AVATAR"), "image/webp");
      expect(deleteObject).toHaveBeenCalledWith("old-a");
      expect(body.avatarUrl).toBe(`https://signed/events/${CODE}/images/avatar-new.webp`);
    });
  });

  describe("DELETE /api/admin/events/:id/photo", () => {
    async function del() {
      const res = await app.fetch(
        new Request("http://localhost/api/admin/events/5/photo", { method: "DELETE", headers: await adminHeaders() }),
      );
      return res.status;
    }

    it("should delete every stored object and null the photo columns", async () => {
      mockDb.query.events.findFirst.mockResolvedValue({
        id: 5, eventCode: CODE, storagePrefix: CODE, avatarS3Key: "a", heroS3Key: "h", heroMobileS3Key: "m", heroOriginalS3Key: "o",
      });
      mockReturning.mockResolvedValue([{ id: 5 }]);
      expect(await del()).toBe(200);
      for (const key of ["a", "h", "m", "o"]) expect(deleteObject).toHaveBeenCalledWith(key);
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          avatarS3Key: null, heroS3Key: null, heroMobileS3Key: null, heroOriginalS3Key: null,
          heroCrop: null, heroFrameOverrides: null, heroGrayscale: false, heroUpdatedAt: null, avatarUpdatedAt: null,
        }),
      );
    });

    it("should return 404 when the event does not exist", async () => {
      mockDb.query.events.findFirst.mockResolvedValue(undefined);
      expect(await del()).toBe(404);
    });
  });
});
