import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { sessions } from "../db/schema/sessions.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import { events } from "../db/schema/retreats.ts";
import { users } from "../db/schema/users.ts";
import { generatePresignedDownloadUrl, getObjectText } from "../services/s3.ts";
import {
  buildPlaybackUrls,
  buildMp4DownloadUrl,
  getVideoMeta,
  parseAvailableResolutions,
  bestAvailableResolution,
  type BunnyResolution,
} from "../services/bunny.ts";
import { AppError } from "../lib/errors.ts";
import { optionalAuthMiddleware, getOptionalUser, getUser } from "../middleware/auth.ts";
import { checkEventAccess } from "../services/access.ts";

const mediaRoutes = new Hono();

// Use optional auth — public event media doesn't require login
mediaRoutes.use("*", optionalAuthMiddleware);

/**
 * Look up the event for a track (track → session → event with audience)
 */
async function getEventForTrack(trackId: number) {
  const track = await db.query.tracks.findFirst({
    where: eq(tracks.id, trackId),
    with: {
      session: {
        with: {
          event: {
            with: { audience: true },
          },
        },
      },
    },
  });
  if (!track) return null;
  return { track, event: track.session?.event ?? null };
}

/**
 * Look up the event for a session (session → event with audience)
 */
async function getEventForSession(sessionId: number) {
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
    with: {
      event: {
        with: { audience: true },
      },
    },
  });
  if (!session) return null;
  return { session, event: session.event ?? null };
}

/**
 * Look up the event for a transcript
 */
async function getEventForTranscript(transcriptId: number) {
  const transcript = await db.query.transcripts.findFirst({
    where: eq(transcripts.id, transcriptId),
    with: {
      event: {
        with: { audience: true },
      },
    },
  });
  if (!transcript) return null;
  return { transcript, event: transcript.event ?? null };
}

/**
 * Build UserForAccess from auth user or return null
 */
async function getUserForAccess(authUser: { id: number; role: string } | null) {
  if (!authUser) return null;
  if (authUser.role === "admin" || authUser.role === "superadmin") {
    return { id: authUser.id, role: authUser.role, subscriptionStatus: "active" as const, subscriptionExpiresAt: null };
  }
  const fullUser = await db.query.users.findFirst({
    where: eq(users.id, authUser.id),
  });
  if (!fullUser) return null;
  return {
    id: fullUser.id,
    role: fullUser.role,
    subscriptionStatus: fullUser.subscriptionStatus,
    subscriptionExpiresAt: fullUser.subscriptionExpiresAt,
  };
}

/**
 * GET /api/media/audio/:trackId - Get presigned S3 URL for audio playback
 */
mediaRoutes.get("/audio/:trackId", async (c) => {
  const trackId = parseInt(c.req.param("trackId"), 10);
  const authUser = getOptionalUser(c);

  const result = await getEventForTrack(trackId);
  if (!result?.track) throw AppError.notFound("Track not found");
  if (!result.track.s3Key) throw AppError.notFound("Audio file not available");

  if (result.event) {
    const userForAccess = await getUserForAccess(authUser);
    const accessResult = await checkEventAccess(userForAccess, result.event);
    if (!accessResult.allowed) {
      if (accessResult.reason === "AUTH_REQUIRED") {
        throw AppError.unauthorized("Authentication required");
      }
      throw AppError.forbidden("Access denied");
    }
  }

  const url = await generatePresignedDownloadUrl(result.track.s3Key);
  return c.json({ url, expiresIn: 3600 });
});

/**
 * GET /api/media/video/session/:sessionId
 *
 * Token-signed Bunny Stream playback URLs for the session's video recording.
 * Audio tracks remain the canonical, topic-indexed content; the session video
 * is the unedited full recording, viewed via Bunny.
 *
 * Returns 404 if the session has no video attached. Same access control as
 * audio (audience rules on the parent event).
 */
mediaRoutes.get("/video/session/:sessionId", async (c) => {
  const sessionId = parseInt(c.req.param("sessionId"), 10);
  const authUser = getOptionalUser(c);

  const result = await getEventForSession(sessionId);
  if (!result?.session) throw AppError.notFound("Session not found");
  if (!result.session.bunnyVideoId) {
    throw AppError.notFound("Video file not available");
  }

  if (result.event) {
    const userForAccess = await getUserForAccess(authUser);
    const accessResult = await checkEventAccess(userForAccess, result.event);
    if (!accessResult.allowed) {
      if (accessResult.reason === "AUTH_REQUIRED") {
        throw AppError.unauthorized("Authentication required");
      }
      throw AppError.forbidden("Access denied");
    }
  }

  const urls = buildPlaybackUrls(result.session.bunnyVideoId);
  return c.json({
    hls: urls.hls,
    iframe: urls.iframe,
    thumbnail: result.session.videoPosterUrl ?? urls.thumbnail,
    durationSeconds: result.session.videoDurationSeconds ?? null,
    expiresAt: urls.expiresAt,
  });
});

/**
 * GET /api/media/video/session/:sessionId/download?quality=720p
 *
 * Token-signed direct-MP4 URL for downloading the session's video to local
 * storage. Picks the best available variant ≤ requested quality (low-res
 * sources may not have a 720p variant). Requires "MP4 Fallback" enabled on
 * the Bunny library.
 */
mediaRoutes.get("/video/session/:sessionId/download", async (c) => {
  const sessionId = parseInt(c.req.param("sessionId"), 10);
  const authUser = getOptionalUser(c);
  const qualityParam = (c.req.query("quality") ?? "720p") as BunnyResolution;
  const allowed: ReadonlySet<string> = new Set([
    "240p", "360p", "480p", "720p", "1080p", "1440p", "2160p",
  ]);
  if (!allowed.has(qualityParam)) {
    throw AppError.badRequest("invalid quality");
  }

  const result = await getEventForSession(sessionId);
  if (!result?.session) throw AppError.notFound("Session not found");
  if (!result.session.bunnyVideoId) {
    throw AppError.notFound("Video file not available");
  }

  if (result.event) {
    const userForAccess = await getUserForAccess(authUser);
    const accessResult = await checkEventAccess(userForAccess, result.event);
    if (!accessResult.allowed) {
      if (accessResult.reason === "AUTH_REQUIRED") {
        throw AppError.unauthorized("Authentication required");
      }
      throw AppError.forbidden("Access denied");
    }
  }

  const meta = await getVideoMeta(result.session.bunnyVideoId);
  const available = parseAvailableResolutions(meta.availableResolutions);
  const chosen = bestAvailableResolution(qualityParam, available);
  if (!chosen) {
    throw AppError.notFound("No downloadable variant available for this video");
  }

  const { url, expiresAt } = buildMp4DownloadUrl(result.session.bunnyVideoId, chosen);
  return c.json({
    url,
    quality: chosen,
    requestedQuality: qualityParam,
    availableResolutions: available,
    expiresAt,
  });
});

/**
 * GET /api/media/readalong/:trackId - Serve Read Along alignment JSON directly
 * Proxied through the API to avoid S3 CORS issues on web.
 */
mediaRoutes.get("/readalong/:trackId", async (c) => {
  const trackId = parseInt(c.req.param("trackId"), 10);
  const authUser = getOptionalUser(c);

  const result = await getEventForTrack(trackId);
  if (!result?.track) throw AppError.notFound("Track not found");
  if (!result.track.readAlongS3Key) throw AppError.notFound("Read Along data not available");

  if (result.event) {
    const userForAccess = await getUserForAccess(authUser);
    const accessResult = await checkEventAccess(userForAccess, result.event);
    if (!accessResult.allowed) {
      if (accessResult.reason === "AUTH_REQUIRED") {
        throw AppError.unauthorized("Authentication required");
      }
      throw AppError.forbidden("Access denied");
    }
  }

  const jsonContent = await getObjectText(result.track.readAlongS3Key);
  return new Response(jsonContent, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
  });
});

/**
 * GET /api/media/transcript/:transcriptId - Serve watermarked PDF
 * Requires authentication (watermark includes user name + email).
 * Add ?download=true for Content-Disposition: attachment.
 */
mediaRoutes.get("/transcript/:transcriptId", async (c) => {
  const transcriptId = parseInt(c.req.param("transcriptId"), 10);
  const authUser = getOptionalUser(c);

  if (!authUser) {
    throw AppError.unauthorized("Authentication required to view transcripts");
  }

  const result = await getEventForTranscript(transcriptId);
  if (!result?.transcript) throw AppError.notFound("Transcript not found");
  if (!result.transcript.s3Key) throw AppError.notFound("Transcript file not available");

  if (result.event) {
    const userForAccess = await getUserForAccess(authUser);
    const accessResult = await checkEventAccess(userForAccess, result.event);
    if (!accessResult.allowed) {
      throw AppError.forbidden("Access denied");
    }
  }

  // Get user's full name for watermark
  const fullUser = await db.query.users.findFirst({
    where: eq(users.id, authUser.id),
  });
  const userName = fullUser
    ? [fullUser.firstName, fullUser.lastName].filter(Boolean).join(" ") || authUser.email
    : authUser.email;
  const watermarkText = `${userName} — ${authUser.email}`;

  // Fetch original PDF from S3
  const presignedUrl = await generatePresignedDownloadUrl(result.transcript.s3Key);
  const pdfResponse = await fetch(presignedUrl);
  if (!pdfResponse.ok) {
    throw AppError.internal("Failed to fetch transcript from storage");
  }
  const originalPdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());

  // Add watermark: single centered line at bottom of each page
  const pdfDoc = await PDFDocument.load(originalPdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 9;
  const textWidth = font.widthOfTextAtSize(watermarkText, fontSize);

  for (const page of pdfDoc.getPages()) {
    const { width } = page.getSize();
    page.drawText(watermarkText, {
      x: (width - textWidth) / 2,
      y: 20,
      size: fontSize,
      font,
      color: rgb(0.75, 0.75, 0.75),
      opacity: 0.5,
    });
  }

  const watermarkedPdfBytes = await pdfDoc.save();

  // Use original filename if available, fall back to generated name
  const rawFilename = result.transcript.originalFilename
    || (() => {
        const eventName = result.event?.titleEn || result.event?.titlePt || "transcript";
        const cleanName = eventName.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 60);
        return `${cleanName}_${result.transcript.language}.pdf`;
      })();

  // Sanitize for Content-Disposition: ASCII-only for filename, UTF-8 in filename*
  const asciiFilename = rawFilename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  const utf8Filename = encodeURIComponent(rawFilename);

  const isDownload = c.req.query("download") === "true";
  const disposition = isDownload ? "attachment" : "inline";

  return new Response(watermarkedPdfBytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`,
      "Content-Length": String(watermarkedPdfBytes.byteLength),
    },
  });
});

export { mediaRoutes };
