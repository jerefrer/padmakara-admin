import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// ─── Mock setup (BEFORE imports) ─────────────────────────────────────────

vi.mock("../../src/db/index.ts", () => {
  const mockWhere = vi.fn(() => Promise.resolve([]));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  return {
    db: {
      select: mockSelect,
      _mockSelect: mockSelect,
      _mockFrom: mockFrom,
      _mockWhere: mockWhere,
    },
  };
});

vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() =>
    Promise.resolve("https://s3.example.com/signed-url"),
  ),
}));

import { db } from "../../src/db/index.ts";
import { createAccessToken } from "../../src/services/auth.ts";

// Access mock helpers from the db mock
const mockSelect = (db as any)._mockSelect as ReturnType<typeof vi.fn>;
const mockFrom = (db as any)._mockFrom as ReturnType<typeof vi.fn>;
const mockWhere = (db as any)._mockWhere as ReturnType<typeof vi.fn>;

// ─── Test data factories ─────────────────────────────────────────────────

function makePublication(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    title: "Guia de Meditação",
    subtitle: null,
    description: "A guide to meditation",
    authors: ["Jigme Khyentse Rinpoche"],
    language: "pt",
    pageCount: 120,
    publicationDate: "2024-01-15",
    coverImageS3Key: "publications/covers/guide.jpg",
    pdfS3Key: "publications/pdfs/guide.pdf",
    fileSizeBytes: 5000000,
    accessLevel: "public",
    status: "published",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSubscriberPublication(overrides: Record<string, any> = {}) {
  return makePublication({
    id: 2,
    title: "Ensinamentos Avançados",
    accessLevel: "subscribers",
    pdfS3Key: "publications/pdfs/advanced.pdf",
    ...overrides,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("GET /api/publications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
    mockFrom.mockImplementation(() => ({ where: mockWhere }));
    mockWhere.mockImplementation(() => Promise.resolve([]));
  });

  it("returns only public publications for unauthenticated users", async () => {
    const publicPub = makePublication();
    const subscriberPub = makeSubscriberPublication();

    // db.select().from(publications).where(status=published)
    mockWhere.mockResolvedValueOnce([publicPub, subscriberPub]);

    const { status, body } = await testJson("/api/publications");

    expect(status).toBe(200);
    // Unauthenticated: should only see the public one
    expect(body.publications).toHaveLength(1);
    expect(body.publications[0].id).toBe(1);
    expect(body.publications[0].title).toBe("Guia de Meditação");
    expect(body.hasHiddenPublications).toBe(true);
  });

  it("returns all publications for authenticated subscriber", async () => {
    const publicPub = makePublication();
    const subscriberPub = makeSubscriberPublication();

    // First select: user subscription lookup
    // Second select: publications query
    mockWhere
      .mockResolvedValueOnce([
        {
          subscriptionStatus: "active",
          subscriptionExpiresAt: new Date(Date.now() + 86400000),
        },
      ])
      .mockResolvedValueOnce([publicPub, subscriberPub]);

    const token = await createAccessToken({
      sub: 1,
      email: "subscriber@test.com",
      role: "user",
    });

    const { status, body } = await testJson("/api/publications", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.publications).toHaveLength(2);
    expect(body.hasHiddenPublications).toBe(false);
  });

  it("returns all publications for admin without subscription check", async () => {
    const publicPub = makePublication();
    const subscriberPub = makeSubscriberPublication();

    // Admin skips user subscription lookup, goes straight to publications query
    mockWhere.mockResolvedValueOnce([publicPub, subscriberPub]);

    const token = await createAccessToken({
      sub: 1,
      email: "admin@test.com",
      role: "admin",
    });

    const { status, body } = await testJson("/api/publications", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.publications).toHaveLength(2);
    expect(body.hasHiddenPublications).toBe(false);
  });

  it("never exposes S3 keys in response", async () => {
    const publicPub = makePublication();

    mockWhere.mockResolvedValueOnce([publicPub]);

    const { status, body } = await testJson("/api/publications");

    expect(status).toBe(200);
    expect(body.publications).toHaveLength(1);
    const pub = body.publications[0];

    // S3 keys must never be exposed
    expect(pub.pdfS3Key).toBeUndefined();
    expect(pub.coverImageS3Key).toBeUndefined();

    // Should have presigned coverImageUrl instead
    expect(pub.coverImageUrl).toBe("https://s3.example.com/signed-url");
  });

  it("generates coverImageUrl only when coverImageS3Key exists", async () => {
    const pubWithCover = makePublication({ coverImageS3Key: "covers/img.jpg" });
    const pubWithoutCover = makePublication({
      id: 3,
      coverImageS3Key: null,
    });

    mockWhere.mockResolvedValueOnce([pubWithCover, pubWithoutCover]);

    const { status, body } = await testJson("/api/publications");

    expect(status).toBe(200);
    expect(body.publications[0].coverImageUrl).toBe(
      "https://s3.example.com/signed-url",
    );
    expect(body.publications[1].coverImageUrl).toBeNull();
  });
});

describe("GET /api/publications/:id/pdf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
    mockFrom.mockImplementation(() => ({ where: mockWhere }));
    mockWhere.mockImplementation(() => Promise.resolve([]));
  });

  it("returns 401 for unauthenticated requests", async () => {
    const { status, body } = await testJson("/api/publications/1/pdf");

    expect(status).toBe(401);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for subscriber-only publication without subscription", async () => {
    const subscriberPub = makeSubscriberPublication();

    // First call: publication lookup; second call: user subscription check
    mockWhere
      .mockResolvedValueOnce([subscriberPub])
      .mockResolvedValueOnce([
        {
          subscriptionStatus: "none",
          subscriptionExpiresAt: null,
        },
      ]);

    const token = await createAccessToken({
      sub: 1,
      email: "user@test.com",
      role: "user",
    });

    const { status, body } = await testJson("/api/publications/2/pdf", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
  });

  it("returns presigned URL for public publication", async () => {
    const publicPub = makePublication();

    mockWhere.mockResolvedValueOnce([publicPub]);

    const token = await createAccessToken({
      sub: 1,
      email: "user@test.com",
      role: "user",
    });

    const { status, body } = await testJson("/api/publications/1/pdf", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.url).toBe("https://s3.example.com/signed-url");
    expect(body.expiresIn).toBe(3600);
  });

  it("returns 404 for non-existent publication", async () => {
    mockWhere.mockResolvedValueOnce([]);

    const token = await createAccessToken({
      sub: 1,
      email: "user@test.com",
      role: "user",
    });

    const { status, body } = await testJson("/api/publications/999/pdf", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns presigned URL for subscriber publication with active subscription", async () => {
    const subscriberPub = makeSubscriberPublication();

    mockWhere
      .mockResolvedValueOnce([subscriberPub])
      .mockResolvedValueOnce([
        {
          subscriptionStatus: "active",
          subscriptionExpiresAt: new Date(Date.now() + 86400000),
        },
      ]);

    const token = await createAccessToken({
      sub: 1,
      email: "subscriber@test.com",
      role: "user",
    });

    const { status, body } = await testJson("/api/publications/2/pdf", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.url).toBe("https://s3.example.com/signed-url");
    expect(body.expiresIn).toBe(3600);
  });

  it("returns 400 for invalid publication ID", async () => {
    const token = await createAccessToken({
      sub: 1,
      email: "user@test.com",
      role: "user",
    });

    const { status, body } = await testJson("/api/publications/abc/pdf", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(400);
  });
});
