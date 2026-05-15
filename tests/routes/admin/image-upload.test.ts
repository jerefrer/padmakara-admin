import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../../../src/index.ts";

// ─── Mocks (must come before route imports) ──────────────────────────────

vi.mock("../../../src/db/index.ts", () => {
  const findFirst = vi.fn();
  const returning = vi.fn();
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return {
    db: {
      query: {
        teachers: { findFirst },
        retreatGroups: { findFirst },
      },
      update,
      _findFirst: findFirst,
      _update: update,
      _set: set,
      _where: where,
      _returning: returning,
    },
  };
});

vi.mock("../../../src/services/s3.ts", () => ({
  putObject: vi.fn(() => Promise.resolve()),
  deleteObject: vi.fn(() => Promise.resolve()),
  buildTeacherAvatarS3Key: vi.fn(
    (id: number) => `teachers/avatars/${id}-fixed.webp`,
  ),
  buildTeacherHeroS3Key: vi.fn(
    (id: number) => `teachers/heroes/${id}-fixed.webp`,
  ),
  buildTeacherHeroMobileS3Key: vi.fn(
    (id: number) => `teachers/heroes/${id}-fixed-m.webp`,
  ),
  buildGroupAvatarS3Key: vi.fn(
    (id: number) => `groups/avatars/${id}-fixed.webp`,
  ),
  buildGroupHeroS3Key: vi.fn(
    (id: number) => `groups/heroes/${id}-fixed.webp`,
  ),
  buildGroupHeroMobileS3Key: vi.fn(
    (id: number) => `groups/heroes/${id}-fixed-m.webp`,
  ),
}));

vi.mock("../../../src/services/image-pipeline.ts", () => ({
  processAvatar: vi.fn(() => Promise.resolve(Buffer.from("AVATAR_RESIZED"))),
  processHero: vi.fn(() => Promise.resolve(Buffer.from("HERO_DESKTOP_RESIZED"))),
  processHeroMobile: vi.fn(() => Promise.resolve(Buffer.from("HERO_MOBILE_RESIZED"))),
}));

vi.mock("../../../src/lib/teacher-utils.ts", () => ({
  resolveTeacherUrls: vi.fn(() =>
    Promise.resolve({
      avatarUrl: "https://signed/avatar.jpg",
      heroUrl: "https://signed/hero.jpg",
    }),
  ),
}));

vi.mock("../../../src/lib/group-utils.ts", () => ({
  resolveGroupUrls: vi.fn(() =>
    Promise.resolve({
      avatarUrl: "https://signed/avatar.jpg",
      heroUrl: "https://signed/hero.jpg",
    }),
  ),
}));

import { db } from "../../../src/db/index.ts";
import { putObject, deleteObject } from "../../../src/services/s3.ts";
import {
  processAvatar,
  processHero,
  processHeroMobile,
} from "../../../src/services/image-pipeline.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const mockFindFirst = (db as any)._findFirst as ReturnType<typeof vi.fn>;
const mockReturning = (db as any)._returning as ReturnType<typeof vi.fn>;
const mockPutObject = putObject as ReturnType<typeof vi.fn>;
const mockDeleteObject = deleteObject as ReturnType<typeof vi.fn>;
const mockProcessAvatar = processAvatar as ReturnType<typeof vi.fn>;
const mockProcessHero = processHero as ReturnType<typeof vi.fn>;
const mockProcessHeroMobile = processHeroMobile as ReturnType<typeof vi.fn>;

// ─── Helpers ─────────────────────────────────────────────────────────────

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

async function userToken() {
  return createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
}

async function postMultipart(
  path: string,
  form: FormData,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const url = new URL(path, "http://localhost");
  const res = await app.fetch(
    new Request(url.toString(), { method: "POST", headers, body: form }),
  );
  // res.json() returns unknown; we know the API always returns a plain JSON object for non-204 responses
  const body = res.status === 204 ? null : (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

function fileFormData(
  fieldName: string,
  filename: string,
  contents: string,
  extra: Record<string, string> = {},
) {
  const form = new FormData();
  form.append(fieldName, new File([contents], filename, { type: "image/jpeg" }));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("POST /api/admin/teachers/:id/avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resizes via sharp, writes WebP to S3, updates the DB, returns the teacher", async () => {
    mockFindFirst.mockResolvedValueOnce(null); // no existing avatar
    mockReturning.mockResolvedValueOnce([
      {
        id: 7,
        name: "JKR",
        avatarS3Key: "teachers/avatars/7-fixed.webp",
        heroS3Key: null,
      },
    ]);

    const token = await adminToken();
    const form = fileFormData("file", "avatar.jpg", "RAW_BYTES");
    const { status, body } = await postMultipart(
      "/api/admin/teachers/7/avatar",
      form,
      { Authorization: `Bearer ${token}` },
    );

    expect(status).toBe(200);
    expect(mockProcessAvatar).toHaveBeenCalledTimes(1);
    expect(mockPutObject).toHaveBeenCalledWith(
      "teachers/avatars/7-fixed.webp",
      Buffer.from("AVATAR_RESIZED"),
      "image/webp",
    );
    expect(mockDeleteObject).not.toHaveBeenCalled(); // no previous key
    expect(body).toMatchObject({
      id: 7,
      avatarS3Key: "teachers/avatars/7-fixed.webp",
      avatarUrl: "https://signed/avatar.jpg",
    });
  });

  it("deletes the previous S3 object when replacing an avatar at a different key", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 7,
      avatarS3Key: "teachers/avatars/7-old.webp",
    });
    mockReturning.mockResolvedValueOnce([
      { id: 7, name: "JKR", avatarS3Key: "teachers/avatars/7-fixed.webp" },
    ]);

    const token = await adminToken();
    const form = fileFormData("file", "avatar.jpg", "RAW");
    const { status } = await postMultipart(
      "/api/admin/teachers/7/avatar",
      form,
      { Authorization: `Bearer ${token}` },
    );

    expect(status).toBe(200);
    expect(mockDeleteObject).toHaveBeenCalledWith("teachers/avatars/7-old.webp");
  });

  it("returns 400 when no file is included", async () => {
    const token = await adminToken();
    const form = new FormData(); // no file
    const { status, body } = await postMultipart(
      "/api/admin/teachers/7/avatar",
      form,
      { Authorization: `Bearer ${token}` },
    );

    expect(status).toBe(400);
    expect(body!.error).toMatch(/missing file/i); // body is non-null: status is 400, not 204
    expect(mockProcessAvatar).not.toHaveBeenCalled();
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid teacher id", async () => {
    const token = await adminToken();
    const form = fileFormData("file", "avatar.jpg", "RAW");
    const { status } = await postMultipart(
      "/api/admin/teachers/abc/avatar",
      form,
      { Authorization: `Bearer ${token}` },
    );
    expect(status).toBe(400);
  });

  it("returns 401 without an auth token", async () => {
    const form = fileFormData("file", "avatar.jpg", "RAW");
    const { status } = await postMultipart(
      "/api/admin/teachers/7/avatar",
      form,
    );
    expect(status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const token = await userToken();
    const form = fileFormData("file", "avatar.jpg", "RAW");
    const { status } = await postMultipart(
      "/api/admin/teachers/7/avatar",
      form,
      { Authorization: `Bearer ${token}` },
    );
    expect(status).toBe(403);
  });
});

describe("POST /api/admin/teachers/:id/hero", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes both desktop and mobile WebP variants, persists focal, returns the teacher", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    mockReturning.mockResolvedValueOnce([
      {
        id: 7,
        heroS3Key: "teachers/heroes/7-fixed.webp",
        heroMobileS3Key: "teachers/heroes/7-fixed-m.webp",
        heroFocalX: 30,
        heroFocalY: 70,
        heroScale: 100,
      },
    ]);

    const token = await adminToken();
    const form = fileFormData("file", "hero.jpg", "RAW", {
      focalX: "30",
      focalY: "70",
    });
    const { status, body } = await postMultipart(
      "/api/admin/teachers/7/hero",
      form,
      { Authorization: `Bearer ${token}` },
    );

    expect(status).toBe(200);
    expect(mockProcessHero).toHaveBeenCalledTimes(1);
    expect(mockProcessHeroMobile).toHaveBeenCalledTimes(1);
    expect(mockPutObject).toHaveBeenCalledWith(
      "teachers/heroes/7-fixed.webp",
      Buffer.from("HERO_DESKTOP_RESIZED"),
      "image/webp",
    );
    expect(mockPutObject).toHaveBeenCalledWith(
      "teachers/heroes/7-fixed-m.webp",
      Buffer.from("HERO_MOBILE_RESIZED"),
      "image/webp",
    );
    expect(body).toMatchObject({
      id: 7,
      heroS3Key: "teachers/heroes/7-fixed.webp",
      heroMobileS3Key: "teachers/heroes/7-fixed-m.webp",
      heroFocalX: 30,
      heroFocalY: 70,
      heroScale: 100,
    });
  });

  it("deletes both old hero S3 objects when replacing", async () => {
    mockFindFirst.mockResolvedValueOnce({
      id: 7,
      heroS3Key: "teachers/heroes/7-old.webp",
      heroMobileS3Key: "teachers/heroes/7-old-m.webp",
    });
    mockReturning.mockResolvedValueOnce([
      {
        id: 7,
        heroS3Key: "teachers/heroes/7-fixed.webp",
        heroMobileS3Key: "teachers/heroes/7-fixed-m.webp",
      },
    ]);

    const token = await adminToken();
    const form = fileFormData("file", "hero.jpg", "RAW");
    const { status } = await postMultipart(
      "/api/admin/teachers/7/hero",
      form,
      { Authorization: `Bearer ${token}` },
    );

    expect(status).toBe(200);
    expect(mockDeleteObject).toHaveBeenCalledWith(
      "teachers/heroes/7-old.webp",
    );
    expect(mockDeleteObject).toHaveBeenCalledWith(
      "teachers/heroes/7-old-m.webp",
    );
  });

  it("clamps focal coordinates outside [0, 100]", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    mockReturning.mockResolvedValueOnce([
      { id: 7, heroFocalX: 100, heroFocalY: 0 },
    ]);

    const token = await adminToken();
    const form = fileFormData("file", "hero.jpg", "RAW", {
      focalX: "999",
      focalY: "-5",
    });
    const { status, body } = await postMultipart(
      "/api/admin/teachers/7/hero",
      form,
      { Authorization: `Bearer ${token}` },
    );

    expect(status).toBe(200);
    expect(body!.heroFocalX).toBe(100); // body is non-null: status is 200, not 204
    expect(body!.heroFocalY).toBe(0);   // body is non-null: status is 200, not 204
  });

  it("defaults focal to 50/50 when fields are missing", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    mockReturning.mockResolvedValueOnce([
      { id: 7, heroFocalX: 50, heroFocalY: 50 },
    ]);

    const token = await adminToken();
    const form = fileFormData("file", "hero.jpg", "RAW"); // no focal fields
    const { status, body } = await postMultipart(
      "/api/admin/teachers/7/hero",
      form,
      { Authorization: `Bearer ${token}` },
    );

    expect(status).toBe(200);
    expect(body!.heroFocalX).toBe(50); // body is non-null: status is 200, not 204
    expect(body!.heroFocalY).toBe(50); // body is non-null: status is 200, not 204
  });
});

describe("POST /api/admin/groups/:id/avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resizes via sharp, writes WebP, and updates the group", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    mockReturning.mockResolvedValueOnce([
      { id: 3, nameEn: "Lisbon", avatarS3Key: "groups/avatars/3-fixed.webp" },
    ]);

    const token = await adminToken();
    const form = fileFormData("file", "avatar.jpg", "RAW");
    const { status, body } = await postMultipart(
      "/api/admin/groups/3/avatar",
      form,
      { Authorization: `Bearer ${token}` },
    );

    expect(status).toBe(200);
    expect(mockProcessAvatar).toHaveBeenCalledTimes(1);
    expect(mockPutObject).toHaveBeenCalledWith(
      "groups/avatars/3-fixed.webp",
      Buffer.from("AVATAR_RESIZED"),
      "image/webp",
    );
    expect(body).toMatchObject({
      id: 3,
      avatarS3Key: "groups/avatars/3-fixed.webp",
    });
  });

  it("returns 401 without an auth token", async () => {
    const form = fileFormData("file", "avatar.jpg", "RAW");
    const { status } = await postMultipart(
      "/api/admin/groups/3/avatar",
      form,
    );
    expect(status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    const token = await userToken();
    const form = fileFormData("file", "avatar.jpg", "RAW");
    const { status } = await postMultipart(
      "/api/admin/groups/3/avatar",
      form,
      { Authorization: `Bearer ${token}` },
    );
    expect(status).toBe(403);
  });
});

describe("POST /api/admin/groups/:id/hero", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes both desktop and mobile WebP variants, persists focal, returns the group", async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    mockReturning.mockResolvedValueOnce([
      {
        id: 3,
        heroS3Key: "groups/heroes/3-fixed.webp",
        heroMobileS3Key: "groups/heroes/3-fixed-m.webp",
        heroFocalX: 25,
        heroFocalY: 80,
        heroScale: 100,
      },
    ]);

    const token = await adminToken();
    const form = fileFormData("file", "hero.jpg", "RAW", {
      focalX: "25",
      focalY: "80",
    });
    const { status, body } = await postMultipart(
      "/api/admin/groups/3/hero",
      form,
      { Authorization: `Bearer ${token}` },
    );

    expect(status).toBe(200);
    expect(mockProcessHero).toHaveBeenCalledTimes(1);
    expect(mockProcessHeroMobile).toHaveBeenCalledTimes(1);
    expect(mockPutObject).toHaveBeenCalledWith(
      "groups/heroes/3-fixed.webp",
      Buffer.from("HERO_DESKTOP_RESIZED"),
      "image/webp",
    );
    expect(mockPutObject).toHaveBeenCalledWith(
      "groups/heroes/3-fixed-m.webp",
      Buffer.from("HERO_MOBILE_RESIZED"),
      "image/webp",
    );
    expect(body).toMatchObject({
      id: 3,
      heroS3Key: "groups/heroes/3-fixed.webp",
      heroMobileS3Key: "groups/heroes/3-fixed-m.webp",
      heroFocalX: 25,
      heroFocalY: 80,
      heroScale: 100,
    });
  });
});
