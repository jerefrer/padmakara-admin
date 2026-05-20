import { describe, expect, it } from "vitest";
import {
  FOLDER_NAME_CONVENTION,
  FILENAME_CONVENTION,
  WRITING_RULES,
  trackCorrectionSchema,
  noteSchema,
  analysisResultSchema,
} from "../../src/services/track-conventions.ts";

describe("track-conventions", () => {
  describe("prompt constants", () => {
    it("exports non-empty folder name convention text", () => {
      expect(FOLDER_NAME_CONVENTION).toMatch(/YYYY\.MM\.DD/);
    });
    it("exports non-empty filename convention text", () => {
      expect(FILENAME_CONVENTION).toMatch(/ASCII|accent/i);
    });
    it("exports non-empty writing rules", () => {
      expect(WRITING_RULES).toMatch(/accent/i);
    });
  });

  describe("trackCorrectionSchema", () => {
    it("accepts a valid correction", () => {
      const ok = trackCorrectionSchema.safeParse({
        field: "displayTitlePt",
        before: "Refugio",
        after: "Refúgio",
        reason: "missing diacritic",
      });
      expect(ok.success).toBe(true);
    });
    it("rejects an unknown field", () => {
      const bad = trackCorrectionSchema.safeParse({
        field: "nope",
        before: "a",
        after: "b",
        reason: "r",
      });
      expect(bad.success).toBe(false);
    });
  });

  describe("noteSchema", () => {
    it("accepts info severity without relatedFilename", () => {
      const ok = noteSchema.safeParse({ severity: "info", message: "ok" });
      expect(ok.success).toBe(true);
    });
    it("accepts warning with relatedFilename", () => {
      const ok = noteSchema.safeParse({
        severity: "warning",
        message: "orphan",
        relatedFilename: "99_bonus.mp3",
      });
      expect(ok.success).toBe(true);
    });
    it("rejects severity outside info|warning", () => {
      const bad = noteSchema.safeParse({ severity: "error", message: "x" });
      expect(bad.success).toBe(false);
    });
  });

  describe("analysisResultSchema", () => {
    it("accepts a minimal valid result", () => {
      const ok = analysisResultSchema.safeParse({
        aiCoverage: {
          totalTracks: 0,
          tracksAnalyzedByAi: 0,
          tracksFromDeterministicFallback: 0,
          chunks: 0,
          chunksFailed: 0,
        },
        event: {
          titleEn: null,
          titlePt: null,
          startDate: null,
          endDate: null,
          matchedGroupIds: [],
          matchedTeacherIds: [],
          matchedPlaceIds: [],
          folderConventionOk: true,
        },
        sessions: [],
        notes: [],
      });
      expect(ok.success).toBe(true);
    });
  });
});
