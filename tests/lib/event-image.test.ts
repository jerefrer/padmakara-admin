import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn((key: string) => Promise.resolve(`https://signed/${key}`)),
}));

import { resolveEventImage, resolveEventImageUrls, eventArtworkUrl } from "../../src/lib/event-image.ts";

describe("resolveEventImage", () => {
  it("should be null when the event has no photo", async () => {
    expect(await resolveEventImage({ id: 1, heroFocalX: 50 })).toBeNull();
  });

  it("should resolve URLs, framing and timestamps when the event has a photo", async () => {
    const image = await resolveEventImage({
      id: 7,
      avatarS3Key: "a",
      heroS3Key: "h",
      heroMobileS3Key: "m",
      heroFocalX: 30,
      heroFocalY: 60,
      heroScale: 100,
      heroFrameOverrides: { page: { focalX: 1, focalY: 2, zoom: 2 } },
      avatarUpdatedAt: new Date("2026-01-01T00:00:00Z"),
      heroUpdatedAt: new Date("2026-01-02T00:00:00Z"),
    });
    expect(image).toMatchObject({
      avatarUrl: "https://signed/a",
      heroUrl: "https://signed/h",
      heroMobileUrl: "https://signed/m",
      heroFocalX: 30,
      heroFocalY: 60,
      heroFrameOverrides: { page: { focalX: 1, focalY: 2, zoom: 2 } },
      avatarUpdatedAt: "2026-01-01T00:00:00.000Z",
      heroUpdatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(image?.artworkUrl).toMatch(/\/api\/events\/7\/artwork\.jpg\?v=1767312000000$/);
  });
});

describe("resolveEventImageUrls", () => {
  it("should set image to null and still strip the raw columns when there is no photo", async () => {
    const event: Record<string, unknown> = { id: 1, titleEn: "x", heroS3Key: null, heroCrop: null };
    await resolveEventImageUrls(event);
    expect(event.image).toBeNull();
    expect("heroS3Key" in event).toBe(false);
    expect("heroCrop" in event).toBe(false);
    expect(event.titleEn).toBe("x");
  });

  it("should never leak S3 keys or the re-edit state into the payload", async () => {
    const event: Record<string, unknown> = {
      id: 1, heroS3Key: "h", avatarS3Key: "a", heroOriginalS3Key: "o", heroCrop: { x: 0 }, heroGrayscale: true,
    };
    await resolveEventImageUrls(event);
    expect(Object.keys(event).sort()).toEqual(["id", "image"]);
  });
});

describe("eventArtworkUrl", () => {
  it("should be null without a hero image", () => {
    expect(eventArtworkUrl({ id: 1, heroS3Key: null })).toBeNull();
  });
});
