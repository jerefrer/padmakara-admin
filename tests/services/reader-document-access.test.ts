import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock setup (BEFORE imports) ─────────────────────────────────────────

const { publicationRows, transcriptRows, mockOpenable, mockFilterEvents, usersFindFirst } = vi.hoisted(() => ({
  publicationRows: { value: [] as Record<string, unknown>[] },
  transcriptRows: { value: [] as Record<string, unknown>[] },
  mockOpenable: vi.fn((_user: unknown, _pubs: { id: number }[]) => Promise.resolve(new Set<number>())),
  mockFilterEvents: vi.fn((_user: unknown, events: { id: number }[]) => Promise.resolve(events)),
  usersFindFirst: vi.fn(() =>
    Promise.resolve({ id: 42, role: "user", subscriptionStatus: "active", subscriptionExpiresAt: null } as unknown),
  ),
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve(publicationRows.value) }) }),
    query: {
      transcripts: { findMany: () => Promise.resolve(transcriptRows.value) },
      users: { findFirst: usersFindFirst },
    },
  },
}));

// The audience rules themselves are tested in tests/services/publication-access and
// tests/services/access; here they only say what this caller may open.
vi.mock("../../src/services/publication-access.ts", () => ({ openablePublications: mockOpenable }));
vi.mock("../../src/services/access.ts", () => ({ filterAccessibleEvents: mockFilterEvents }));

import {
  canOpenReaderDocument,
  openableReaderDocuments,
} from "../../src/services/reader-document-access.ts";

const USER = { id: 42, role: "user" };
const ADMIN = { id: 1, role: "admin" };

function publication(id: number, status = "published") {
  return { id, title: `Publication ${id}`, status, audienceId: 7 };
}

function event(id: number, extra: Record<string, unknown> = {}) {
  return { id, status: "published", titleEn: `Event ${id}`, titlePt: `Evento ${id}`, audience: { slug: "free-subscribers" }, ...extra };
}

function transcript(id: number, ev: unknown, extra: Record<string, unknown> = {}) {
  return { id, language: "pt", s3Key: `events/E/transcripts/${id}.pdf`, published: true, event: ev, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  publicationRows.value = [];
  transcriptRows.value = [];
  mockFilterEvents.mockImplementation((_user, events) => Promise.resolve(events));
});

describe("publications", () => {
  it("should open a published publication its audience lets the caller into", async () => {
    publicationRows.value = [publication(5)];
    mockOpenable.mockResolvedValueOnce(new Set([5]));

    const docs = await openableReaderDocuments(USER, [{ type: "publication", id: 5 }]);

    expect(docs.get("publication:5")).toEqual({ type: "publication", id: 5, title: "Publication 5" });
  });

  it("should refuse a publication its audience keeps the caller out of", async () => {
    publicationRows.value = [publication(5)];
    mockOpenable.mockResolvedValueOnce(new Set());

    expect(await canOpenReaderDocument(USER, { type: "publication", id: 5 })).toBe(false);
  });

  it.each([["forthcoming"], ["draft"]])("should refuse a %s publication to a non-admin", async (status) => {
    publicationRows.value = [publication(5, status)];
    mockOpenable.mockResolvedValue(new Set([5]));

    expect(await canOpenReaderDocument(USER, { type: "publication", id: 5 })).toBe(false);
  });

  it("should open a draft publication to an admin", async () => {
    publicationRows.value = [publication(5, "draft")];
    mockOpenable.mockResolvedValueOnce(new Set([5]));

    expect(await canOpenReaderDocument(ADMIN, { type: "publication", id: 5 })).toBe(true);
  });

  it("should refuse a publication that does not exist", async () => {
    expect(await canOpenReaderDocument(USER, { type: "publication", id: 99 })).toBe(false);
  });
});

describe("transcripts", () => {
  it("should open a transcript of an event the caller can open, with its event", async () => {
    transcriptRows.value = [transcript(9, event(3))];

    const docs = await openableReaderDocuments(USER, [{ type: "transcript", id: 9 }]);

    expect(docs.get("transcript:9")).toEqual({
      type: "transcript",
      id: 9,
      language: "pt",
      event: { id: 3, titleEn: "Event 3", titlePt: "Evento 3" },
    });
    expect(mockFilterEvents).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42, subscriptionStatus: "active" }),
      [expect.objectContaining({ id: 3 })],
    );
  });

  it("should refuse a transcript of an event the caller cannot open", async () => {
    transcriptRows.value = [transcript(9, event(3))];
    mockFilterEvents.mockResolvedValueOnce([]);

    expect(await canOpenReaderDocument(USER, { type: "transcript", id: 9 })).toBe(false);
  });

  it("should refuse a transcript whose event hides its transcripts section", async () => {
    transcriptRows.value = [transcript(9, event(3, { transcriptsPublished: false }))];

    expect(await canOpenReaderDocument(USER, { type: "transcript", id: 9 })).toBe(false);
  });

  it("should refuse an unpublished transcript file to a non-admin, and open it to an admin", async () => {
    transcriptRows.value = [transcript(9, event(3), { published: false })];

    expect(await canOpenReaderDocument(USER, { type: "transcript", id: 9 })).toBe(false);
    expect(await canOpenReaderDocument(ADMIN, { type: "transcript", id: 9 })).toBe(true);
  });

  it("should refuse a transcript without a file", async () => {
    transcriptRows.value = [transcript(9, event(3), { s3Key: null })];

    expect(await canOpenReaderDocument(USER, { type: "transcript", id: 9 })).toBe(false);
  });

  it("should refuse everything to a caller whose account no longer exists", async () => {
    transcriptRows.value = [transcript(9, event(3))];
    usersFindFirst.mockResolvedValueOnce(undefined);

    expect(await canOpenReaderDocument(USER, { type: "transcript", id: 9 })).toBe(false);
  });
});

it("should keep a publication and a transcript with the same id apart", async () => {
  publicationRows.value = [publication(5)];
  transcriptRows.value = [transcript(5, event(3))];
  mockOpenable.mockResolvedValueOnce(new Set());

  const docs = await openableReaderDocuments(USER, [
    { type: "publication", id: 5 },
    { type: "transcript", id: 5 },
  ]);

  expect([...docs.keys()]).toEqual(["transcript:5"]);
});
