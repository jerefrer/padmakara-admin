import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// vi.hoisted ensures these variables are available when vi.mock factories run
// (vi.mock calls are hoisted to the top of the file before variable declarations)
// Mirrors the mockDb shape used in tests/routes/events.test.ts.
const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    query: {
      events: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      audiences: {
        findFirst: vi.fn(),
      },
      downloadRequests: {
        findFirst: vi.fn(),
      },
      users: {
        findFirst: vi.fn(),
      },
      userEventAttendance: {
        findFirst: vi.fn(),
      },
      userGroupMemberships: {
        findFirst: vi.fn(),
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
    insert: vi.fn((_table: unknown) => ({
      values: vi.fn((_data: unknown) => ({
        returning: vi.fn(() => Promise.resolve([{}])),
      })),
    })),
  };
  return { mockDb };
});

vi.mock("../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3.example.com/file")),
}));

import { createAccessToken } from "../../src/services/auth.ts";

/** Full user row returned by db.query.users.findFirst inside requireEventAccess. */
function makeUserRow(role: string) {
  return {
    id: 1,
    email: "test@test.com",
    role,
    subscriptionStatus: "none",
    subscriptionExpiresAt: null,
  };
}

async function bearerToken(role: string) {
  const token = await createAccessToken({ sub: 1, email: "test@test.com", role });
  return { Authorization: `Bearer ${token}` };
}

describe("GET /api/events/:id — visible eventFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("echoes the eventFiles array from the DB relation in the detail payload", async () => {
    const mockEvent = {
      id: 42,
      status: "published",
      audience: { slug: "free-anyone" },
      sessions: [],
      eventTeachers: [],
      eventRetreatGroups: [],
      eventPlaces: [],
      eventPublications: [],
      eventFiles: [
        { id: 1, eventId: 42, fileType: "document", originalFilename: "handout.pdf", sortOrder: 0 },
        { id: 2, eventId: 42, fileType: "image", originalFilename: "photo.jpg", sortOrder: 1 },
      ],
    };

    mockDb.query.events.findFirst.mockResolvedValueOnce(mockEvent);
    mockDb.query.users.findFirst.mockResolvedValueOnce(makeUserRow("user"));

    const { status, body } = await testJson("/api/events/42", {
      headers: await bearerToken("user"),
    });

    expect(status).toBe(200);
    expect(body.eventFiles).toHaveLength(2);
    expect(body.eventFiles.map((f: { id: number }) => f.id)).toEqual([1, 2]);
  });
});
