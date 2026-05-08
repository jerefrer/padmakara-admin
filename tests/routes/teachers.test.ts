import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// ─── Mock setup (BEFORE imports) ─────────────────────────────────────────

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      teachers: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
    },
  },
}));

vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() =>
    Promise.resolve("https://s3.example.com/signed-url"),
  ),
}));

import { db } from "../../src/db/index.ts";
import { createAccessToken } from "../../src/services/auth.ts";

const mockFindMany = (db as any).query.teachers.findMany as ReturnType<typeof vi.fn>;
const mockFindFirst = (db as any).query.teachers.findFirst as ReturnType<typeof vi.fn>;

// ─── Test data factories ─────────────────────────────────────────────────

function makeTeacher(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    name: "Jigme Khyentse Rinpoche",
    abbreviation: "JKR",
    aliases: [],
    photoUrl: null,
    avatarS3Key: "teachers/jkr/avatar.jpg",
    heroS3Key: "teachers/jkr/hero.jpg",
    heroMobileS3Key: "teachers/jkr/hero-mobile.jpg",
    heroFocalX: 50,
    heroFocalY: 50,
    heroScale: 100,
    avatarUpdatedAt: new Date("2024-01-01T00:00:00Z"),
    heroUpdatedAt: new Date("2024-01-01T00:00:00Z"),
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-06-15T10:00:00Z"),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("GET /api/teachers", () => {
  let token: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    token = await createAccessToken({ sub: 1, email: "user@test.com", role: "user" });
  });

  it("returns 401 without auth token", async () => {
    const { status } = await testJson("/api/teachers");
    expect(status).toBe(401);
  });

  it("returns list of teachers for authenticated user", async () => {
    mockFindMany.mockResolvedValueOnce([makeTeacher()]);

    const { status, body } = await testJson("/api/teachers", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Jigme Khyentse Rinpoche");
    expect(body[0].abbreviation).toBe("JKR");
  });

  it("each teacher row includes updatedAt", async () => {
    mockFindMany.mockResolvedValueOnce([makeTeacher(), makeTeacher({ id: 2, name: "Rabjam Rinpoche", abbreviation: "RR" })]);

    const { status, body } = await testJson("/api/teachers", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    for (const teacher of body) {
      expect(teacher.updatedAt).toBeDefined();
      expect(typeof teacher.updatedAt).toBe("string");
    }
  });

  it("resolves S3 keys to presigned URLs", async () => {
    mockFindMany.mockResolvedValueOnce([makeTeacher()]);

    const { status, body } = await testJson("/api/teachers", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body[0].avatarUrl).toBe("https://s3.example.com/signed-url");
    expect(body[0].heroUrl).toBe("https://s3.example.com/signed-url");
  });

  it("never exposes raw S3 keys", async () => {
    mockFindMany.mockResolvedValueOnce([makeTeacher()]);

    const { status, body } = await testJson("/api/teachers", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body[0].avatarS3Key).toBeUndefined();
    expect(body[0].heroS3Key).toBeUndefined();
    expect(body[0].heroMobileS3Key).toBeUndefined();
  });

  it("returns empty array when no teachers exist", async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const { status, body } = await testJson("/api/teachers", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body).toHaveLength(0);
  });
});

describe("GET /api/teachers/:abbreviation", () => {
  let token: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    token = await createAccessToken({ sub: 1, email: "user@test.com", role: "user" });
  });

  it("returns 401 without auth token", async () => {
    const { status } = await testJson("/api/teachers/JKR");
    expect(status).toBe(401);
  });

  it("returns one teacher by abbreviation", async () => {
    mockFindFirst.mockResolvedValueOnce(makeTeacher());

    const { status, body } = await testJson("/api/teachers/JKR", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.abbreviation).toBe("JKR");
    expect(body.name).toBe("Jigme Khyentse Rinpoche");
  });

  it("includes updatedAt in single teacher response", async () => {
    mockFindFirst.mockResolvedValueOnce(makeTeacher());

    const { status, body } = await testJson("/api/teachers/JKR", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.updatedAt).toBeDefined();
    expect(typeof body.updatedAt).toBe("string");
  });

  it("returns 404 when abbreviation does not match", async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    const { status, body } = await testJson("/api/teachers/UNKNOWN", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("resolves S3 keys to presigned URLs in detail response", async () => {
    mockFindFirst.mockResolvedValueOnce(makeTeacher());

    const { status, body } = await testJson("/api/teachers/JKR", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.avatarUrl).toBe("https://s3.example.com/signed-url");
    expect(body.avatarS3Key).toBeUndefined();
  });
});
