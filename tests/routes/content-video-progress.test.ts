import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// ─── Mocks ───────────────────────────────────────────────────────────────

const {
  mockEventVideoFindFirst,
  mockUserFindFirst,
  mockVideoProgressFindFirst,
  mockInsertReturning,
  mockUpdateReturning,
} = vi.hoisted(() => {
  return {
    mockEventVideoFindFirst: vi.fn(),
    mockUserFindFirst: vi.fn(),
    mockVideoProgressFindFirst: vi.fn(),
    mockInsertReturning: vi.fn(),
    mockUpdateReturning: vi.fn(),
  };
});

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      eventVideos: {
        findFirst: (...args: any[]) => mockEventVideoFindFirst(...args),
      },
      users: {
        findFirst: (...args: any[]) => mockUserFindFirst(...args),
      },
      videoProgress: {
        findFirst: (...args: any[]) => mockVideoProgressFindFirst(...args),
      },
    },
    insert: () => ({
      values: () => ({
        returning: () => mockInsertReturning(),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => mockUpdateReturning(),
        }),
      }),
    }),
  },
}));

import { createAccessToken } from "../../src/services/auth.ts";

async function authHeader() {
  const token = await createAccessToken({ sub: 1, email: "user@test.com", role: "user" });
  return { Authorization: `Bearer ${token}` };
}

function activeUser(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    role: "user",
    subscriptionStatus: "active",
    subscriptionExpiresAt: null,
    ...overrides,
  };
}

function publicEventVideo(overrides: Record<string, any> = {}) {
  return {
    id: 5,
    eventId: 1,
    bunnyVideoId: "guid",
    event: {
      id: 1,
      status: "published",
      audience: { slug: "free-anyone" },
      audienceId: 1,
    },
    ...overrides,
  };
}

describe("GET /api/content/video-progress/:videoId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    const { status } = await testJson("/api/content/video-progress/5");
    expect(status).toBe(401);
  });

  it("returns 404 when the video does not exist", async () => {
    mockEventVideoFindFirst.mockResolvedValueOnce(null);

    const { status } = await testJson("/api/content/video-progress/999", {
      headers: await authHeader(),
    });
    expect(status).toBe(404);
  });

  it("returns the zero shape when no progress row exists", async () => {
    mockEventVideoFindFirst.mockResolvedValueOnce(publicEventVideo());
    mockUserFindFirst.mockResolvedValueOnce(activeUser());
    mockVideoProgressFindFirst.mockResolvedValueOnce(null);

    const { status, body } = await testJson("/api/content/video-progress/5", {
      headers: await authHeader(),
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      positionSeconds: 0,
      durationSeconds: null,
      completedAt: null,
      updatedAt: null,
    });
  });

  it("returns the saved progress row when one exists", async () => {
    mockEventVideoFindFirst.mockResolvedValueOnce(publicEventVideo());
    mockUserFindFirst.mockResolvedValueOnce(activeUser());
    mockVideoProgressFindFirst.mockResolvedValueOnce({
      id: 1,
      userId: 1,
      videoId: 5,
      positionSeconds: 42,
      durationSeconds: 100,
      completedAt: null,
      updatedAt: new Date("2026-05-08T10:00:00Z").toISOString(),
    });

    const { status, body } = await testJson("/api/content/video-progress/5", {
      headers: await authHeader(),
    });

    expect(status).toBe(200);
    expect(body.positionSeconds).toBe(42);
    expect(body.durationSeconds).toBe(100);
  });

  it("returns 403 (access denied) when the user cannot access the video's event", async () => {
    mockEventVideoFindFirst.mockResolvedValueOnce(
      publicEventVideo({
        event: { id: 1, status: "published", audience: { slug: "free-subscribers" }, audienceId: 2 },
      }),
    );
    mockUserFindFirst.mockResolvedValueOnce(activeUser({ subscriptionStatus: "expired" }));

    const { status } = await testJson("/api/content/video-progress/5", {
      headers: await authHeader(),
    });

    expect(status).toBe(403);
  });
});

describe("POST /api/content/video-progress/:videoId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    const { status } = await testJson("/api/content/video-progress/5", {
      method: "POST",
      body: JSON.stringify({ positionSeconds: 30 }),
    });
    expect(status).toBe(401);
  });

  it("returns 404 when the video does not exist", async () => {
    mockEventVideoFindFirst.mockResolvedValueOnce(null);

    const { status } = await testJson("/api/content/video-progress/999", {
      method: "POST",
      headers: await authHeader(),
      body: JSON.stringify({ positionSeconds: 30 }),
    });
    expect(status).toBe(404);
  });

  it("inserts a new row when none exists", async () => {
    mockEventVideoFindFirst.mockResolvedValueOnce(publicEventVideo());
    mockUserFindFirst.mockResolvedValueOnce(activeUser());
    mockVideoProgressFindFirst.mockResolvedValueOnce(null);
    mockInsertReturning.mockResolvedValueOnce([
      {
        id: 1,
        userId: 1,
        videoId: 5,
        positionSeconds: 30,
        durationSeconds: 100,
        completedAt: null,
        updatedAt: new Date().toISOString(),
      },
    ]);

    const { status, body } = await testJson("/api/content/video-progress/5", {
      method: "POST",
      headers: await authHeader(),
      body: JSON.stringify({ positionSeconds: 30, durationSeconds: 100 }),
    });

    expect(status).toBe(201);
    expect(body.positionSeconds).toBe(30);
    expect(body.videoId).toBe(5);
  });

  it("upserts (updates) an existing row", async () => {
    mockEventVideoFindFirst.mockResolvedValueOnce(publicEventVideo());
    mockUserFindFirst.mockResolvedValueOnce(activeUser());
    mockVideoProgressFindFirst.mockResolvedValueOnce({
      id: 1,
      userId: 1,
      videoId: 5,
      positionSeconds: 20,
      durationSeconds: 100,
      completedAt: null,
      updatedAt: new Date(0).toISOString(),
    });
    mockUpdateReturning.mockResolvedValueOnce([
      {
        id: 1,
        userId: 1,
        videoId: 5,
        positionSeconds: 55,
        durationSeconds: 100,
        completedAt: null,
        updatedAt: new Date().toISOString(),
      },
    ]);

    const { status, body } = await testJson("/api/content/video-progress/5", {
      method: "POST",
      headers: await authHeader(),
      body: JSON.stringify({ positionSeconds: 55, durationSeconds: 100 }),
    });

    expect(status).toBe(200);
    expect(body.positionSeconds).toBe(55);
  });

  it("returns 403 (access denied) when the user cannot access the video's event", async () => {
    mockEventVideoFindFirst.mockResolvedValueOnce(
      publicEventVideo({
        event: { id: 1, status: "published", audience: { slug: "free-subscribers" }, audienceId: 2 },
      }),
    );
    mockUserFindFirst.mockResolvedValueOnce(activeUser({ subscriptionStatus: "expired" }));

    const { status } = await testJson("/api/content/video-progress/5", {
      method: "POST",
      headers: await authHeader(),
      body: JSON.stringify({ positionSeconds: 10 }),
    });

    expect(status).toBe(403);
  });
});
