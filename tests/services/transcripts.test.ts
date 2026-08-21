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

import { hasTranscriptForLanguage } from "../../src/services/transcripts.ts";

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
