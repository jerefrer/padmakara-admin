import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";
import { testRequest } from "../helpers.ts";

const { mockDb, mockGetObjectBytes } = vi.hoisted(() => ({
  mockDb: { query: { teachers: { findFirst: vi.fn() } } },
  mockGetObjectBytes: vi.fn(),
}));

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3.example.com/file")),
  getObjectBytes: mockGetObjectBytes,
}));

/** A 300x200 image: red left half, blue right half. */
async function twoToneImage(): Promise<Uint8Array> {
  const left = await sharp({ create: { width: 150, height: 200, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const buf = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#0000ff" } })
    .composite([{ input: left, left: 0, top: 0 }])
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

const teacher = (over: Record<string, unknown> = {}) => ({
  id: 3,
  heroS3Key: "teachers/t/hero.png",
  heroFocalX: 50,
  heroFocalY: 50,
  heroFrameOverrides: null,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

describe("GET /api/teachers/:id/artwork.jpg", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return 404 when the teacher has no hero image", async () => {
    mockDb.query.teachers.findFirst.mockResolvedValueOnce(teacher({ heroS3Key: null }));
    const res = await testRequest("/api/teachers/3/artwork.jpg");
    expect(res.status).toBe(404);
    expect(mockGetObjectBytes).not.toHaveBeenCalled();
  });

  it("should return 404 when the teacher does not exist", async () => {
    mockDb.query.teachers.findFirst.mockResolvedValueOnce(undefined);
    const res = await testRequest("/api/teachers/99/artwork.jpg");
    expect(res.status).toBe(404);
  });

  it("should serve an unauthenticated 800x800 JPEG with a long cache", async () => {
    mockDb.query.teachers.findFirst.mockResolvedValueOnce(teacher());
    mockGetObjectBytes.mockResolvedValueOnce({ body: await twoToneImage(), contentType: "image/png" });
    const res = await testRequest("/api/teachers/3/artwork.jpg?v=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toContain("max-age=31536000");
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 800, 800]);
  });

  it("should crop around the focal point", async () => {
    mockDb.query.teachers.findFirst.mockResolvedValueOnce(teacher({ heroFocalX: 0 }));
    mockGetObjectBytes.mockResolvedValueOnce({ body: await twoToneImage(), contentType: "image/png" });
    const res = await testRequest("/api/teachers/3/artwork.jpg");
    const { data } = await sharp(Buffer.from(await res.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
    // Focal at the left edge: the 200x200 square is the left side, mostly red.
    expect(data[0]).toBeGreaterThan(200);
    expect(data[2]).toBeLessThan(60);
  });
});
