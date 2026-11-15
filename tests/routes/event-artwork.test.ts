import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";
import { testRequest } from "../helpers.ts";

const { mockDb, mockGetObjectBytes } = vi.hoisted(() => ({
  mockDb: { query: { events: { findFirst: vi.fn() } } },
  mockGetObjectBytes: vi.fn(),
}));

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3.example.com/file")),
  getObjectBytes: mockGetObjectBytes,
}));

async function image(): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: 300, height: 200, channels: 3, background: "#00ff00" } }).png().toBuffer());
}

const event = (over: Record<string, unknown> = {}) => ({
  id: 4, status: "published", heroS3Key: "events/x/images/hero.webp", heroFocalX: 50, heroFocalY: 50, heroFrameOverrides: null, ...over,
});

describe("GET /api/events/:id/artwork.jpg", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should serve an unauthenticated 800x800 JPEG with a long cache", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(event());
    mockGetObjectBytes.mockResolvedValueOnce({ body: await image(), contentType: "image/webp" });
    const res = await testRequest("/api/events/4/artwork.jpg?v=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toContain("max-age=31536000");
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 800, 800]);
  });

  it("should return 404 when the event has no photo", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(event({ heroS3Key: null }));
    expect((await testRequest("/api/events/4/artwork.jpg")).status).toBe(404);
  });

  it("should return 404 when the event is not published", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(event({ status: "draft" }));
    const res = await testRequest("/api/events/4/artwork.jpg");
    expect(res.status).toBe(404);
    expect(mockGetObjectBytes).not.toHaveBeenCalled();
  });

  it("should return 404 when the event does not exist", async () => {
    mockDb.query.events.findFirst.mockResolvedValueOnce(undefined);
    expect((await testRequest("/api/events/99/artwork.jpg")).status).toBe(404);
  });
});
