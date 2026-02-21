import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import { events } from "../db/schema/retreats.ts";
import { users } from "../db/schema/users.ts";
import { generatePresignedDownloadUrl } from "../services/s3.ts";
import { AppError } from "../lib/errors.ts";
import { optionalAuthMiddleware, getOptionalUser } from "../middleware/auth.ts";
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
 * GET /api/media/transcript/:transcriptId - Get presigned S3 URL for PDF
 */
mediaRoutes.get("/transcript/:transcriptId", async (c) => {
  const transcriptId = parseInt(c.req.param("transcriptId"), 10);
  const authUser = getOptionalUser(c);

  const result = await getEventForTranscript(transcriptId);
  if (!result?.transcript) throw AppError.notFound("Transcript not found");
  if (!result.transcript.s3Key) throw AppError.notFound("Transcript file not available");

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

  const url = await generatePresignedDownloadUrl(result.transcript.s3Key);
  return c.json({ url, expiresIn: 3600 });
});

export { mediaRoutes };
