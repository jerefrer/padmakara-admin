import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn((key: string) =>
    Promise.resolve(`https://s3.example.com/presigned/${key}`)
  ),
}));

import {
  resolveTeacherUrls,
  pickPhotoTeacherId,
  orderEventTeachers,
  resolveEventTeacherUrls,
} from "../../src/lib/teacher-utils.ts";

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
      heroFrameOverrides: null,
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
      heroFrameOverrides: null,
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

  it("exposes the per-frame hero overrides stored with the hero", async () => {
    const overrides = { page: { focalX: 40, focalY: 60, zoom: 1.5 } };
    const result = await resolveTeacherUrls({
      id: 9,
      name: "T",
      abbreviation: "T",
      photoUrl: null,
      avatarS3Key: null,
      heroS3Key: "teachers/heroes/9.webp",
      heroMobileS3Key: null,
      heroFocalX: 50,
      heroFocalY: 50,
      heroScale: 100,
      heroFrameOverrides: overrides,
      avatarUpdatedAt: null,
      heroUpdatedAt: null,
    });
    expect(result.heroFrameOverrides).toEqual(overrides);
  });
});

describe("pickPhotoTeacherId", () => {
  it("should pick the first teacher with a hero image in the event's order", () => {
    const list = [{ teacher: { id: 1 } }, { teacher: { id: 2, heroUrl: "h2" } }, { teacher: { id: 3, heroUrl: "h3" } }];
    expect(pickPhotoTeacherId(list)).toBe(2);
  });

  it("should prefer a later hero over an earlier avatar-only teacher", () => {
    const list = [{ teacher: { id: 1, avatarUrl: "a1" } }, { teacher: { id: 2, heroUrl: "h2" } }];
    expect(pickPhotoTeacherId(list)).toBe(2);
  });

  it("should fall back to the first avatar-only teacher when nobody has a hero", () => {
    const list = [{ teacher: { id: 1 } }, { teacher: { id: 2, avatarUrl: "a2" } }];
    expect(pickPhotoTeacherId(list)).toBe(2);
  });

  it("should be null when no teacher has a photo or the list is empty", () => {
    expect(pickPhotoTeacherId([{ teacher: { id: 1 } }])).toBeNull();
    expect(pickPhotoTeacherId(undefined)).toBeNull();
  });
});

describe("orderEventTeachers", () => {
  it("should list the main teachers before the guests, each in their saved position", () => {
    const list = [
      { teacherId: 3, role: "guest", position: 1 },
      { teacherId: 1, role: "teacher", position: 1 },
      { teacherId: 4, role: "guest", position: 0 },
      { teacherId: 2, role: "teacher", position: 0 },
    ];

    expect(orderEventTeachers(list).map((et) => et.teacherId)).toEqual([2, 1, 4, 3]);
  });

  it("should keep the loaded order when positions tie or are missing", () => {
    const list = [{ teacherId: 5, role: "teacher" }, { teacherId: 6, role: "teacher" }];

    expect(orderEventTeachers(list).map((et) => et.teacherId)).toEqual([5, 6]);
  });
});

describe("pickPhotoTeacherId with guests", () => {
  it("should prefer a main teacher's avatar over a guest's hero", () => {
    const list = [
      { role: "guest", teacher: { id: 9, heroUrl: "h9" } },
      { role: "teacher", teacher: { id: 1, avatarUrl: "a1" } },
    ];

    expect(pickPhotoTeacherId(list)).toBe(1);
  });

  it("should fall back to a guest's photo when no main teacher has one", () => {
    const list = [
      { role: "teacher", teacher: { id: 1 } },
      { role: "guest", teacher: { id: 9, avatarUrl: "a9" } },
    ];

    expect(pickPhotoTeacherId(list)).toBe(9);
  });
});

describe("resolveEventTeacherUrls ordering", () => {
  it("should return the event's teachers main first, in position order", async () => {
    const teacher = (id: number) => ({
      id, name: `T${id}`, abbreviation: `T${id}`, photoUrl: null, avatarS3Key: null, heroS3Key: null,
      heroMobileS3Key: null, heroFocalX: 50, heroFocalY: 50, heroScale: 100, avatarUpdatedAt: null, heroUpdatedAt: null,
    });
    const event = {
      eventTeachers: [
        { teacherId: 3, role: "guest", position: 2, teacher: teacher(3) },
        { teacherId: 2, role: "teacher", position: 1, teacher: teacher(2) },
        { teacherId: 1, role: "teacher", position: 0, teacher: teacher(1) },
      ],
    };

    await resolveEventTeacherUrls(event);

    expect(event.eventTeachers.map((et) => [et.teacherId, et.role])).toEqual([
      [1, "teacher"],
      [2, "teacher"],
      [3, "guest"],
    ]);
  });
});
