import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindManyTranscripts } = vi.hoisted(() => {
  const mockFindManyTranscripts = vi.fn(() => Promise.resolve<any[]>([]));
  return { mockFindManyTranscripts };
});

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      transcripts: { findMany: mockFindManyTranscripts },
    },
  },
}));

import { hasTranscriptForLanguage, pickTranscriptKey } from "../../src/services/transcripts.ts";

describe("hasTranscriptForLanguage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true for a matching-language row with a non-null s3Key", async () => {
    mockFindManyTranscripts.mockResolvedValueOnce([
      { eventId: 1, language: "en", s3Key: "events/E1/transcripts/en.pdf" },
    ]);
    await expect(hasTranscriptForLanguage(1, "en")).resolves.toBe(true);
  });

  it("returns false when the only row is in a different language", async () => {
    mockFindManyTranscripts.mockResolvedValueOnce([
      { eventId: 1, language: "pt", s3Key: "events/E1/transcripts/pt.pdf" },
    ]);
    await expect(hasTranscriptForLanguage(1, "en")).resolves.toBe(false);
  });

  it("returns false when the matching-language row has a null s3Key", async () => {
    mockFindManyTranscripts.mockResolvedValueOnce([{ eventId: 1, language: "en", s3Key: null }]);
    await expect(hasTranscriptForLanguage(1, "en")).resolves.toBe(false);
  });

  it("returns false when there are no rows at all", async () => {
    mockFindManyTranscripts.mockResolvedValueOnce([]);
    await expect(hasTranscriptForLanguage(1, "en")).resolves.toBe(false);
  });

  it("returns true when at least one of several rows matches", async () => {
    mockFindManyTranscripts.mockResolvedValueOnce([
      { eventId: 1, language: "pt", s3Key: "events/E1/transcripts/pt.pdf" },
      { eventId: 1, language: "en", s3Key: null },
      { eventId: 1, language: "en", s3Key: "events/E1/transcripts/en.pdf" },
    ]);
    await expect(hasTranscriptForLanguage(1, "en")).resolves.toBe(true);
  });
});

describe("pickTranscriptKey", () => {
  const row = (id: number, language: string, s3Key: string | null, isExcerpt = false) => ({
    id, language, s3Key, isExcerpt,
  });

  it("should return the key of the transcript in the job's language", () => {
    const rows = [row(1, "pt", "events/F/transcripts/pt.pdf"), row(2, "en", "events/F/transcripts/en.pdf")];
    expect(pickTranscriptKey(rows, "en")).toBe("events/F/transcripts/en.pdf");
  });

  it("should fall back to any transcript with a file when none is in the language", () => {
    expect(pickTranscriptKey([row(1, "pt", "events/F/transcripts/pt.pdf")], "en")).toBe(
      "events/F/transcripts/pt.pdf",
    );
  });

  it("should prefer the full text over an excerpt, then the oldest row", () => {
    const rows = [
      row(1, "en", "events/F/transcripts/excerpt.pdf", true),
      row(3, "en", "events/F/transcripts/b.pdf"),
      row(2, "en", "events/F/transcripts/a.pdf"),
    ];
    expect(pickTranscriptKey(rows, "en")).toBe("events/F/transcripts/a.pdf");
  });

  it("should return null when no row has a file", () => {
    expect(pickTranscriptKey([row(1, "en", null)], "en")).toBeNull();
    expect(pickTranscriptKey([], "en")).toBeNull();
  });
});
