import { describe, expect, it } from "vitest";
import { detailsSummary, readAlongTrackCount, transcriptionSummary } from "./eventSectionSummaries";

const translate = (key: string, options?: { smart_count?: number }) =>
  `${key.split(".").pop()}:${options?.smart_count ?? ""}`;

describe("detailsSummary", () => {
  it("should name the retreat group right after the event type", () => {
    const summary = detailsSummary({
      eventType: { nameEn: "Parallel Retreats", abbreviation: "RET" },
      groups: [{ nameEn: "Guru Yoga", namePt: "Guru Ioga" }],
      dateRange: "14–15 Apr 2025",
      teachers: [{ name: "Jigme Khyentse Rinpoche" }],
      locale: "en",
    });
    expect(summary).toBe("Parallel Retreats (RET) · Guru Yoga · 14–15 Apr 2025 · Jigme Khyentse Rinpoche");
  });

  it("should use the Portuguese names when the interface is in Portuguese", () => {
    const summary = detailsSummary({
      eventType: null,
      groups: [{ nameEn: "Guru Yoga", namePt: "Guru Ioga" }],
      dateRange: "",
      teachers: [],
      locale: "pt",
    });
    expect(summary).toBe("Guru Ioga");
  });

  it("should leave out what is not set", () => {
    const summary = detailsSummary({ eventType: null, groups: [], dateRange: "", teachers: [], locale: "en" });
    expect(summary).toBe("");
  });
});

describe("readAlongTrackCount", () => {
  it("should count only the tracks with a read-along file", () => {
    const sessions = [
      { tracks: [{ readAlongS3Key: "a.json" }, { readAlongS3Key: null }] },
      { tracks: [{ readAlongS3Key: "b.json" }, {}] },
    ];
    expect(readAlongTrackCount(sessions)).toBe(2);
  });

  it("should be zero when the event has not loaded", () => {
    expect(readAlongTrackCount(undefined)).toBe(0);
  });
});

describe("transcriptionSummary", () => {
  it("should say when the read-along is done, next to the transcripts", () => {
    expect(transcriptionSummary({ transcriptCount: 1, readAlongTracks: 49, translate })).toBe(
      "transcriptsSummary:1 · readAlongSummary:49",
    );
  });

  it("should show the transcripts alone when there is no read-along", () => {
    expect(transcriptionSummary({ transcriptCount: 2, readAlongTracks: 0, translate })).toBe("transcriptsSummary:2");
  });

  it("should say nothing yet when there is neither", () => {
    expect(transcriptionSummary({ transcriptCount: 0, readAlongTracks: 0, translate })).toBe("nothingYet:");
  });
});
