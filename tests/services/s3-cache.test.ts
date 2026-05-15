import { describe, it, expect } from "vitest";
import { isCacheableKey } from "../../src/services/s3.ts";

describe("isCacheableKey", () => {
  describe("cacheable — image keys only", () => {
    it("returns true for a teacher avatar key", () => {
      expect(isCacheableKey("teachers/avatars/42-1716800000000.jpg")).toBe(true);
    });

    it("returns true for a teacher hero (desktop) key", () => {
      expect(isCacheableKey("teachers/heroes/7-1716800000000.jpg")).toBe(true);
    });

    it("returns true for a teacher hero mobile key", () => {
      // Mobile variant uses the same heroes/ prefix with a -m suffix in the filename
      expect(isCacheableKey("teachers/heroes/7-1716800000000-m.jpg")).toBe(true);
    });

    it("returns true for a group avatar key", () => {
      expect(isCacheableKey("groups/avatars/3-1716800000000.png")).toBe(true);
    });

    it("returns true for a group hero (desktop) key", () => {
      expect(isCacheableKey("groups/heroes/3-1716800000000.jpg")).toBe(true);
    });

    it("returns true for a group hero mobile key", () => {
      expect(isCacheableKey("groups/heroes/3-1716800000000-m.jpg")).toBe(true);
    });
  });

  describe("not cacheable — sensitive content keys", () => {
    it("returns false for an audio track key", () => {
      // buildTrackS3Key: events/{eventCode}/{filename}
      expect(isCacheableKey("events/20240418-JKR-PP3-CCA/001-track.mp3")).toBe(false);
    });

    it("returns false for a transcript PDF key", () => {
      // buildTranscriptS3Key: events/{eventCode}/transcripts/{filename}
      expect(isCacheableKey("events/20240418-JKR-PP3-CCA/transcripts/session1.pdf")).toBe(false);
    });

    it("returns false for a read-along JSON key", () => {
      // buildReadAlongS3Key: events/{eventCode}/read-along/{filename}
      expect(isCacheableKey("events/20240418-JKR-PP3-CCA/read-along/track1.json")).toBe(false);
    });

    it("returns false for a ZIP download key", () => {
      // buildZipS3Key: downloads/{eventCode}/{name}.zip
      expect(isCacheableKey("downloads/20240418-JKR-PP3-CCA/abc-123.zip")).toBe(false);
    });

    it("returns false for an unrecognised key", () => {
      expect(isCacheableKey("unknown/some-arbitrary-object.bin")).toBe(false);
    });

    it("returns false for an empty key", () => {
      expect(isCacheableKey("")).toBe(false);
    });
  });
});
