import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

// ─── Mocks (must come before route imports) ──────────────────────────────

vi.mock("../../../src/db/index.ts", () => {
  const mockFindFirstEventVideo = vi.fn(() => Promise.resolve<any>(null));
  return {
    db: {
      query: {
        eventVideos: { findFirst: mockFindFirstEventVideo },
      },
      _findFirstEventVideo: mockFindFirstEventVideo,
    },
  };
});

vi.mock("../../../src/services/transcripts.ts", () => ({
  hasTranscriptForLanguage: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("../../../src/services/subtitles.ts", () => ({
  submitSubtitleJob: vi.fn(() =>
    Promise.resolve({
      jobId: "job-1",
      batchJobId: "batch-1",
      status: "submitted",
      videoId: 3,
      language: "en",
      trackCount: 2,
    }),
  ),
  cancelSubtitleJob: vi.fn(() =>
    Promise.resolve({ id: "job-1", status: "failed", errorMessage: "Cancelled by an administrator" }),
  ),
}));

import { db } from "../../../src/db/index.ts";
import { hasTranscriptForLanguage } from "../../../src/services/transcripts.ts";
import { submitSubtitleJob, cancelSubtitleJob } from "../../../src/services/subtitles.ts";
import { AppError } from "../../../src/lib/errors.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const mockFindFirstEventVideo = (db as any)._findFirstEventVideo as ReturnType<typeof vi.fn>;
const adminToken = () => createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });

describe("subtitle-jobs admin routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /admin/subtitle-jobs/transcript-status", () => {
    it("reports whether the video's event has a transcript in the requested language", async () => {
      mockFindFirstEventVideo.mockResolvedValueOnce({ id: 3, eventId: 7 });
      (hasTranscriptForLanguage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
      const token = await adminToken();

      const { status, body } = await testJson(
        "/api/admin/subtitle-jobs/transcript-status?videoId=3&language=en",
        { headers: { Authorization: `Bearer ${token}` } },
      );

      expect(status).toBe(200);
      expect(body).toEqual({ hasTranscript: true, language: "en" });
      expect(hasTranscriptForLanguage).toHaveBeenCalledWith(7, "en");
    });

    it("returns 404 when the video does not exist", async () => {
      mockFindFirstEventVideo.mockResolvedValueOnce(null);
      const token = await adminToken();

      const { status } = await testJson(
        "/api/admin/subtitle-jobs/transcript-status?videoId=999&language=en",
        { headers: { Authorization: `Bearer ${token}` } },
      );

      expect(status).toBe(404);
    });

    it("rejects non-admins", async () => {
      const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
      const { status } = await testJson(
        "/api/admin/subtitle-jobs/transcript-status?videoId=3&language=en",
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(status).toBe(403);
    });
  });

  describe("POST /admin/subtitle-jobs", () => {
    it("submits the job and forwards acknowledgeNoTranscript", async () => {
      const token = await adminToken();
      const { status, body } = await testJson("/api/admin/subtitle-jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: 3, language: "en", acknowledgeNoTranscript: true }),
      });

      expect(status).toBe(202);
      expect(body).toMatchObject({ jobId: "job-1", videoId: 3 });
      expect(submitSubtitleJob).toHaveBeenCalledWith(3, {
        language: "en",
        whisperModel: undefined,
        acknowledgeNoTranscript: true,
      });
    });

    it("defaults acknowledgeNoTranscript to false when omitted", async () => {
      const token = await adminToken();
      await testJson("/api/admin/subtitle-jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: 3 }),
      });

      expect(submitSubtitleJob).toHaveBeenCalledWith(
        3,
        expect.objectContaining({ acknowledgeNoTranscript: false }),
      );
    });

    it("propagates the service's refusal as an error response", async () => {
      (submitSubtitleJob as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        AppError.badRequest("No en transcript found for event E1", "NO_TRANSCRIPT"),
      );
      const token = await adminToken();

      const { status } = await testJson("/api/admin/subtitle-jobs", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: 3 }),
      });

      expect(status).toBe(400);
    });
  });

  describe("POST /admin/subtitle-jobs/:jobId/cancel", () => {
    it("cancels the job", async () => {
      const token = await adminToken();
      const { status, body } = await testJson("/api/admin/subtitle-jobs/job-1/cancel", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({ status: "failed" });
      expect(cancelSubtitleJob).toHaveBeenCalledWith("job-1");
    });

    it("returns 409 when the job has already finished", async () => {
      (cancelSubtitleJob as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        AppError.conflict("This job has already finished and cannot be cancelled"),
      );
      const token = await adminToken();

      const { status } = await testJson("/api/admin/subtitle-jobs/job-1/cancel", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(status).toBe(409);
    });
  });
});
