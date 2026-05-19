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
  signCdnPath,
  type BunnyResolution,
} from "../services/bunny.ts";
import { issueMat, verifyMat } from "../services/media-access.ts";
import { config } from "../config.ts";
import { AppError } from "../lib/errors.ts";
import { optionalAuthMiddleware, getOptionalUser, getUser } from "../middleware/auth.ts";
import { checkEventAccess, denialToHttpError } from "../services/access.ts";

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
    if (!accessResult.allowed) denialToHttpError(accessResult.reason);
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
    if (!accessResult.allowed) denialToHttpError(accessResult.reason);
  }

  const urls = buildPlaybackUrls(result.session.bunnyVideoId);

  // Issue a media access token (MAT) and build the HLS-proxy URL. The proxy
  // signs each Bunny URL on the fly and redirects, so native players get
  // full HLS + ABR + per-segment token authentication, and we don't pay any
  // bandwidth cost (segments stream Bunny→user direct via 302). Audience
  // access is verified above; the MAT carries that proof for ~4h, scoped
  // to this session and (when authenticated) this user.
  const mat = await issueMat({
    userId: authUser?.id ?? 0,
    sessionId,
    bunnyVideoId: result.session.bunnyVideoId,
  });

  const baseUrl = proxyBaseUrl(c, sessionId);
  const proxyHls = `${baseUrl}/master.m3u8?mat=${encodeURIComponent(mat.token)}`;

  return c.json({
    proxyHls,
    iframe: urls.iframe,
    hls: urls.hls,
    thumbnail: result.session.videoPosterUrl ?? urls.thumbnail,
    durationSeconds: result.session.videoDurationSeconds ?? null,
    expiresAt: mat.expiresAt,
  });
});

// ─────────────────────────────────────────────────────────────────────
// HLS proxy: rewrites Bunny's playlist URLs through this backend so we
// can sign each Bunny request individually (Bunny's pull zone only
// validates exact-URL tokens, not path-prefix tokens). Segments are
// served via 302 redirect — the bytes go Bunny→client direct, the
// backend just stamps each request with a fresh signature.
//
// All three endpoints accept ?mat=<token> rather than relying on the
// caller's session JWT, because native HLS players don't reliably
// pass Authorization headers to sub-resources fetched from a playlist.
// The MAT is short-lived, scoped to one session and one user, and is
// validated cryptographically without a DB lookup.
// ─────────────────────────────────────────────────────────────────────

const BUNNY_PROXY_TTL_SECONDS = 5 * 60;

async function authorizeProxyRequest(
  matParam: string | undefined,
  routeSessionId: number,
): Promise<string> {
  if (!matParam) throw AppError.unauthorized("Missing media access token");
  const decoded = await verifyMat(matParam);
  if (!decoded) throw AppError.unauthorized("Invalid or expired media access token");
  if (decoded.sid !== routeSessionId) {
    throw AppError.forbidden("Token is not valid for this session");
  }
  return decoded.gid;
}

function bunnyUrl(path: string): string {
  if (!config.bunny.cdnHostname) {
    throw new Error("BUNNY_STREAM_CDN_HOSTNAME is not configured");
  }
  const expires = Math.floor(Date.now() / 1000) + BUNNY_PROXY_TTL_SECONDS;
  const token = signCdnPath(path, expires);
  return `https://${config.bunny.cdnHostname}${path}?token=${token}&expires=${expires}`;
}

function proxyBaseUrl(c: any, sessionId: number): string {
  // Honour X-Forwarded-Proto / X-Forwarded-Host so URLs stay https when
  // the API runs behind Caddy (prod). c.req.url reports the upstream
  // http://localhost:3000 scheme/host inside the systemd unit, which
  // would force every segment fetch through an extra http→https 308.
  const reqUrl = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? reqUrl.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? reqUrl.host;
  return `${proto}://${host}/api/media/video/hls/${sessionId}`;
}

/**
 * Master playlist. Fetches the upstream `/{guid}/playlist.m3u8` and rewrites
 * each sub-playlist reference (e.g. `360p/video.m3u8`) into a URL that
 * routes back through this proxy with the MAT preserved.
 */
mediaRoutes.get("/video/hls/:sessionId/master.m3u8", async (c) => {
  const sessionId = parseInt(c.req.param("sessionId"), 10);
  const mat = c.req.query("mat");
  const guid = await authorizeProxyRequest(mat, sessionId);

  const upstream = bunnyUrl(`/${guid}/playlist.m3u8`);
  const res = await fetch(upstream);
  if (!res.ok) {
    throw AppError.internal(`Bunny returned ${res.status} for master playlist`);
  }
  const body = await res.text();

  const base = proxyBaseUrl(c, sessionId);
  const matEnc = encodeURIComponent(mat!);

  // Sub-playlists are referenced as `<quality>/video.m3u8` — single line
  // per variant, no leading `#`.
  const rewritten = body.replace(
    /^([^\s#][^\r\n]*\.m3u8)\s*$/gm,
    (line) => {
      const trimmed = line.trim();
      const quality = trimmed.split("/")[0]!;
      return `${base}/v/${encodeURIComponent(quality)}?mat=${matEnc}`;
    },
  );

  c.header("Content-Type", "application/vnd.apple.mpegurl");
  c.header("Cache-Control", "no-store");
  return c.body(rewritten);
});

/**
 * Sub-playlist for a specific quality. Fetches `/{guid}/{quality}/video.m3u8`
 * upstream and rewrites every segment URL to route through this proxy.
 */
mediaRoutes.get("/video/hls/:sessionId/v/:quality", async (c) => {
  const sessionId = parseInt(c.req.param("sessionId"), 10);
  const quality = c.req.param("quality");
  // Defensive: only allow a small known set of variant names.
  if (!/^[0-9]{2,4}p$/.test(quality)) {
    throw AppError.badRequest("Invalid quality variant");
  }
  const mat = c.req.query("mat");
  const guid = await authorizeProxyRequest(mat, sessionId);

  const upstream = bunnyUrl(`/${guid}/${quality}/video.m3u8`);
  const res = await fetch(upstream);
  if (!res.ok) {
    throw AppError.internal(`Bunny returned ${res.status} for ${quality} sub-playlist`);
  }
  const body = await res.text();

  const base = proxyBaseUrl(c, sessionId);
  const matEnc = encodeURIComponent(mat!);

  // Segment URIs are non-comment lines that aren't another m3u8.
  const rewritten = body.replace(
    /^([^\s#][^\r\n]*)$/gm,
    (line) => {
      const trimmed = line.trim();
      if (trimmed.endsWith(".m3u8")) return line; // ignore stray sub-playlist refs
      const fullPath = `${quality}/${trimmed}`;
      return `${base}/s?p=${encodeURIComponent(fullPath)}&mat=${matEnc}`;
    },
  );

  c.header("Content-Type", "application/vnd.apple.mpegurl");
  c.header("Cache-Control", "no-store");
  return c.body(rewritten);
});

/**
 * Segment redirect. Verifies the MAT, builds a fresh signed Bunny URL for
 * the requested path, and 302's the client. The actual segment bytes flow
 * Bunny→client without passing through this backend.
 */
mediaRoutes.get("/video/hls/:sessionId/s", async (c) => {
  const sessionId = parseInt(c.req.param("sessionId"), 10);
  const mat = c.req.query("mat");
  const segPath = c.req.query("p");
  if (!segPath) throw AppError.badRequest("Missing segment path");

  // Path safety: relative-only, no traversal, no leading slash, no scheme.
  if (
    segPath.includes("..") ||
    segPath.startsWith("/") ||
    /^[a-z]+:/i.test(segPath)
  ) {
    throw AppError.badRequest("Invalid segment path");
  }

  const guid = await authorizeProxyRequest(mat, sessionId);
  const upstream = bunnyUrl(`/${guid}/${segPath}`);
  return c.redirect(upstream, 302);
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
    if (!accessResult.allowed) denialToHttpError(accessResult.reason);
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
    if (!accessResult.allowed) denialToHttpError(accessResult.reason);
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
    if (!accessResult.allowed) denialToHttpError(accessResult.reason);
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
