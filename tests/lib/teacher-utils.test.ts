import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn((key: string) =>
    Promise.resolve(`https://s3.example.com/presigned/${key}`)
  ),
}));

import { resolveTeacherUrls } from "../../src/lib/teacher-utils.ts";

describe("resolveTeacherUrls", () => {
  it("resolves S3 keys to presigned URLs (avatar + desktop hero + mobile hero)", async () => {
    const teacher = {
      id: 1,
      name: "Pema Wangyal Rinpoche",
      abbreviation: "PWR",
      photoUrl: "https://old-photo.example.com/pwr.jpg",
      avatarS3Key: "teachers/avatars/1-123456.webp",
      heroS3Key: "teachers/heroes/1-123456.webp",
      heroMobileS3Key: "teachers/heroes/1-123456-m.webp",
      heroFocalX: 50,
      heroFocalY: 50,
      heroScale: 100,
      avatarUpdatedAt: new Date("2026-03-31T10:00:00Z"),
      heroUpdatedAt: new Date("2026-03-31T10:00:00Z"),
    };

    const result = await resolveTeacherUrls(teacher);

    expect(result).toEqual({
      id: 1,
      name: "Pema Wangyal Rinpoche",
      abbreviation: "PWR",
      avatarUrl: "https://s3.example.com/presigned/teachers/avatars/1-123456.webp",
      heroUrl: "https://s3.example.com/presigned/teachers/heroes/1-123456.webp",
      heroMobileUrl: "https://s3.example.com/presigned/teachers/heroes/1-123456-m.webp",
      heroFocalX: 50,
      heroFocalY: 50,
      heroScale: 100,
      avatarUpdatedAt: "2026-03-31T10:00:00.000Z",
      heroUpdatedAt: "2026-03-31T10:00:00.000Z",
    });
  });

  it("returns null heroMobileUrl for legacy records that pre-date the variant rollout", async () => {
    const teacher = {
      id: 4,
      name: "Legacy Teacher",
      abbreviation: "LT",
      photoUrl: null,
      avatarS3Key: "teachers/avatars/4-old.webp",
      heroS3Key: "teachers/heroes/4-old.webp",
      heroMobileS3Key: null,
      heroFocalX: 50,
      heroFocalY: 50,
      heroScale: 100,
      avatarUpdatedAt: null,
      heroUpdatedAt: null,
    };

    const result = await resolveTeacherUrls(teacher);

    expect(result.heroUrl).toBe(
      "https://s3.example.com/presigned/teachers/heroes/4-old.webp",
    );
    expect(result.heroMobileUrl).toBeNull();
  });

  it("falls back to photoUrl when no avatarS3Key", async () => {
    const teacher = {
      id: 2,
      name: "Jigme Khyentse Rinpoche",
      abbreviation: "JKR",
      photoUrl: "https://old-photo.example.com/jkr.jpg",
      avatarS3Key: null,
      heroS3Key: null,
      heroMobileS3Key: null,
      heroFocalX: 50,
      heroFocalY: 50,
      heroScale: 100,
      avatarUpdatedAt: null,
      heroUpdatedAt: null,
    };

    const result = await resolveTeacherUrls(teacher);

    expect(result).toEqual({
      id: 2,
      name: "Jigme Khyentse Rinpoche",
      abbreviation: "JKR",
      avatarUrl: "https://old-photo.example.com/jkr.jpg",
      heroUrl: null,
      heroMobileUrl: null,
      heroFocalX: 50,
      heroFocalY: 50,
      heroScale: 100,
      avatarUpdatedAt: null,
      heroUpdatedAt: null,
    });
  });

  it("returns null avatarUrl when no S3 key and no photoUrl", async () => {
    const teacher = {
      id: 3,
      name: "New Teacher",
      abbreviation: "NT",
      photoUrl: null,
      avatarS3Key: null,
      heroS3Key: null,
      heroMobileS3Key: null,
      heroFocalX: 50,
      heroFocalY: 50,
      heroScale: 100,
      avatarUpdatedAt: null,
      heroUpdatedAt: null,
    };

    const result = await resolveTeacherUrls(teacher);

    expect(result.avatarUrl).toBeNull();
    expect(result.heroUrl).toBeNull();
    expect(result.heroMobileUrl).toBeNull();
  });
});
