import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// ─── Mock setup (BEFORE imports) ─────────────────────────────────────────

vi.mock("../../src/db/index.ts", () => {
  const mockFrom = vi.fn();
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  return {
    db: {
      select: mockSelect,
      _mockSelect: mockSelect,
      _mockFrom: mockFrom,
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

const mockSelect = (db as any)._mockSelect as ReturnType<typeof vi.fn>;
const mockFrom = (db as any)._mockFrom as ReturnType<typeof vi.fn>;

/**
 * Drizzle-style chainable thenable: awaitable at any step (`from(...)` or
 * `from(...).where(...)`), both resolving to `rows`. The test data is
 * pre-filtered for the scenario under test, so `.where()` does not actually
 * narrow — it just returns the same rows wrapped in another thenable.
 */
function chainable(rows: any[]) {
  return {
    then: (onFulfilled: any, onRejected?: any) =>
      Promise.resolve(rows).then(onFulfilled, onRejected),
    where: vi.fn(() => chainable(rows)),
  };
}

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
  });

  it("returns only public publications for unauthenticated users", async () => {
    const publicPub = makePublication();
    const subscriberPub = makeSubscriberPublication();

    // No auth → no user lookup, single publications query
    mockFrom.mockReturnValueOnce(chainable([publicPub, subscriberPub]));

    const { status, body } = await testJson("/api/publications");

    expect(status).toBe(200);
    expect(body.publications).toHaveLength(1);
    expect(body.publications[0].id).toBe(1);
    expect(body.publications[0].title).toBe("Guia de Meditação");
    expect(body.hasHiddenPublications).toBe(true);
  });

  it("returns only public publications for authenticated non-subscriber", async () => {
    const publicPub = makePublication();
    const subscriberPub = makeSubscriberPublication();

    mockFrom
      .mockReturnValueOnce(
        chainable([
          { subscriptionStatus: "none", subscriptionExpiresAt: null },
        ]),
      )
      .mockReturnValueOnce(chainable([publicPub, subscriberPub]));

    const token = await createAccessToken({
      sub: 1,
      email: "free@test.com",
      role: "user",
    });

    const { status, body } = await testJson("/api/publications", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.publications).toHaveLength(1);
    expect(body.publications[0].id).toBe(1);
    expect(body.hasHiddenPublications).toBe(true);
  });

  it("hides subscriber publications from authenticated user with expired subscription", async () => {
    const publicPub = makePublication();
    const subscriberPub = makeSubscriberPublication();

    mockFrom
      .mockReturnValueOnce(
        chainable([
          {
            subscriptionStatus: "active",
            // Well past the grace window — one day past expiry still counts as a member
            // (see hasActiveSubscription), so this has to model a genuinely lapsed one.
            subscriptionExpiresAt: new Date(Date.now() - 30 * 86400000),
          },
        ]),
      )
      .mockReturnValueOnce(chainable([publicPub, subscriberPub]));

    const token = await createAccessToken({
      sub: 1,
      email: "expired@test.com",
      role: "user",
    });

    const { status, body } = await testJson("/api/publications", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.publications).toHaveLength(1);
    expect(body.hasHiddenPublications).toBe(true);
  });

  it("returns all publications for authenticated subscriber", async () => {
    const publicPub = makePublication();
    const subscriberPub = makeSubscriberPublication();

    mockFrom
      .mockReturnValueOnce(
        chainable([
          {
            subscriptionStatus: "active",
            subscriptionExpiresAt: new Date(Date.now() + 86400000),
          },
        ]),
      )
      .mockReturnValueOnce(chainable([publicPub, subscriberPub]));

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

    // Admin → skip user lookup, only one from() call
    mockFrom.mockReturnValueOnce(chainable([publicPub, subscriberPub]));

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

    mockFrom.mockReturnValueOnce(chainable([publicPub]));

    const { status, body } = await testJson("/api/publications");

    expect(status).toBe(200);
    expect(body.publications).toHaveLength(1);
    const pub = body.publications[0];

    expect(pub.pdfS3Key).toBeUndefined();
    expect(pub.coverImageS3Key).toBeUndefined();
    expect(pub.coverImageUrl).toBe("https://s3.example.com/signed-url");
  });

  it("generates coverImageUrl only when coverImageS3Key exists", async () => {
    const pubWithCover = makePublication({ coverImageS3Key: "covers/img.jpg" });
    const pubWithoutCover = makePublication({
      id: 3,
      coverImageS3Key: null,
    });

    mockFrom.mockReturnValueOnce(chainable([pubWithCover, pubWithoutCover]));

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
  });

  it("returns presigned URL for public publication WITHOUT auth", async () => {
    const publicPub = makePublication();
    mockFrom.mockReturnValueOnce(chainable([publicPub]));

    const { status, body } = await testJson("/api/publications/1/pdf");

    expect(status).toBe(200);
    expect(body.url).toBe("https://s3.example.com/signed-url");
    expect(body.expiresIn).toBe(3600);
  });

  it("returns 401 for subscribers-only publication when unauthenticated", async () => {
    const subscriberPub = makeSubscriberPublication();
    mockFrom.mockReturnValueOnce(chainable([subscriberPub]));

    const { status, body } = await testJson("/api/publications/2/pdf");

    expect(status).toBe(401);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for subscribers-only publication when user lacks subscription", async () => {
    const subscriberPub = makeSubscriberPublication();
    mockFrom
      .mockReturnValueOnce(chainable([subscriberPub]))
      .mockReturnValueOnce(
        chainable([
          { subscriptionStatus: "none", subscriptionExpiresAt: null },
        ]),
      );

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

  it("returns presigned URL for public publication when authenticated", async () => {
    const publicPub = makePublication();
    mockFrom.mockReturnValueOnce(chainable([publicPub]));

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
    mockFrom.mockReturnValueOnce(chainable([]));

    const { status, body } = await testJson("/api/publications/999/pdf");

    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });

  it("returns presigned URL for subscriber publication with active subscription", async () => {
    const subscriberPub = makeSubscriberPublication();
    mockFrom
      .mockReturnValueOnce(chainable([subscriberPub]))
      .mockReturnValueOnce(
        chainable([
          {
            subscriptionStatus: "active",
            subscriptionExpiresAt: new Date(Date.now() + 86400000),
          },
        ]),
      );

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

  it("returns presigned URL for subscriber publication when caller is admin", async () => {
    const subscriberPub = makeSubscriberPublication();
    // Admin → skip user lookup, single publication lookup
    mockFrom.mockReturnValueOnce(chainable([subscriberPub]));

    const token = await createAccessToken({
      sub: 1,
      email: "admin@test.com",
      role: "admin",
    });

    const { status, body } = await testJson("/api/publications/2/pdf", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.url).toBe("https://s3.example.com/signed-url");
  });

  it("returns 400 for invalid publication ID", async () => {
    const { status } = await testJson("/api/publications/abc/pdf");
    expect(status).toBe(400);
  });
});
