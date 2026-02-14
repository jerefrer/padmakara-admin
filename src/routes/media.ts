import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import { events } from "../db/schema/retreats.ts";
import { users } from "../db/schema/users.ts";
import { generatePresignedDownloadUrl } from "../services/s3.ts";
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
  const filename = result.transcript.originalFilename
    || (() => {
        const eventName = result.event?.titleEn || result.event?.titlePt || "transcript";
        const cleanName = eventName.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 60);
        return `${cleanName}_${result.transcript.language}.pdf`;
      })();

  const isDownload = c.req.query("download") === "true";

  return new Response(watermarkedPdfBytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${isDownload ? "attachment" : "inline"}; filename="${filename}"`,
      "Content-Length": String(watermarkedPdfBytes.byteLength),
    },
  });
});

export { mediaRoutes };
