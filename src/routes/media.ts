import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { eventVideos } from "../db/schema/event-videos.ts";
import { videoSubtitles } from "../db/schema/video-subtitles.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import { eventFiles } from "../db/schema/event-files.ts";
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
 * Look up the event for an event_video (event_video → event with audience).
 * Playback, HLS proxy, and MP4 download are all keyed on the event_video
 * row's id.
 */
async function getVideoForPlayback(videoId: number) {
  const video = await db.query.eventVideos.findFirst({
    where: eq(eventVideos.id, videoId),
    with: { event: { with: { audience: true } } },
  });
  if (!video) return null;
  return { video, event: video.event ?? null };
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
 * Watermark every page of a PDF with a single centered line of text near the
 * bottom (e.g. viewer name + email). Shared by the transcript and generic
 * file routes so sensitive documents get identical per-user watermarking.
 */
async function watermarkPdf(originalPdfBytes: Uint8Array, watermarkText: string): Promise<Uint8Array> {
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
  return await pdfDoc.save();
}

/**
 * Look up the event for a generic event file (event_file → event with audience)
 */
async function getEventForFile(fileId: number) {
  const file = await db.query.eventFiles.findFirst({
    where: eq(eventFiles.id, fileId),
    with: { event: { with: { audience: true } } },
  });
  if (!file) return null;
  return { file, event: file.event ?? null };
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
 * GET /api/media/video/:videoId
 *
 * Token-signed Bunny Stream playback URLs for one recording (event_video
 * row) attached to an event. Audio tracks remain the canonical,
 * topic-indexed content; event videos are unedited full recordings,
 * viewed via Bunny. An event may have several — one per recording.
 *
 * Returns 404 if the event_video doesn't exist. Same access control as
 * audio (audience rules on the parent event).
 */
mediaRoutes.get("/video/:videoId", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const authUser = getOptionalUser(c);

  const result = await getVideoForPlayback(videoId);
  if (!result?.video) throw AppError.notFound("Video not found");

  if (result.event) {
    const userForAccess = await getUserForAccess(authUser);
    const accessResult = await checkEventAccess(userForAccess, result.event);
    if (!accessResult.allowed) denialToHttpError(accessResult.reason);
  }

  const urls = buildPlaybackUrls(result.video.bunnyVideoId);

  // Issue a media access token (MAT) and build the HLS-proxy URL. The proxy
  // signs each Bunny URL on the fly and redirects, so native players get
  // full HLS + ABR + per-segment token authentication, and we don't pay any
  // bandwidth cost (segments stream Bunny→user direct via 302). Audience
  // access is verified above; the MAT carries that proof for ~4h, scoped
  // to this event_video and (when authenticated) this user.
  const mat = await issueMat({
    userId: authUser?.id ?? 0,
    videoId,
    bunnyVideoId: result.video.bunnyVideoId,
  });

  const baseUrl = proxyBaseUrl(c, videoId);
  const proxyHls = `${baseUrl}/master.m3u8?mat=${encodeURIComponent(mat.token)}`;

  return c.json({
    proxyHls,
    iframe: urls.iframe,
    hls: urls.hls,
    thumbnail: result.video.posterUrl ?? urls.thumbnail,
    durationSeconds: result.video.durationSeconds ?? null,
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
  routeVideoId: number,
): Promise<string> {
  if (!matParam) throw AppError.unauthorized("Missing media access token");
  const decoded = await verifyMat(matParam);
  if (!decoded) throw AppError.unauthorized("Invalid or expired media access token");
  if (decoded.svid !== routeVideoId) {
    throw AppError.forbidden("Token is not valid for this video");
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

function proxyBaseUrl(c: any, videoId: number): string {
  // Honour X-Forwarded-Proto / X-Forwarded-Host so URLs stay https when
  // the API runs behind Caddy (prod). c.req.url reports the upstream
  // http://localhost:3000 scheme/host inside the systemd unit, which
  // would force every segment fetch through an extra http→https 308.
  const reqUrl = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? reqUrl.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? reqUrl.host;
  return `${proto}://${host}/api/media/video/hls/${videoId}`;
}

/**
 * Inject subtitle renditions into a (already variant-rewritten) HLS master
 * playlist so the player's CC menu offers them. Declares one
 * `#EXT-X-MEDIA:TYPE=SUBTITLES` per language (off by default — the user opts
 * in via the CC menu) and tags every `#EXT-X-STREAM-INF` variant with the
 * `SUBTITLES` group. Pure/testable: `subPlaylistUrl(lang)` builds the URI.
 */
export function injectSubtitleRenditions(
  master: string,
  subLangs: { language: string; label: string | null }[],
  subPlaylistUrl: (lang: string) => string,
): string {
  if (subLangs.length === 0) return master;

  // Point every variant stream at the subtitles group.
  let out = master.replace(
    /^(#EXT-X-STREAM-INF:[^\r\n]*)$/gm,
    (line) => `${line},SUBTITLES="subs"`,
  );

  const mediaLines = subLangs
    .map((s) => {
      const name = (s.label || s.language.toUpperCase()).replace(/"/g, "");
      return (
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${name}",` +
        `LANGUAGE="${s.language}",AUTOSELECT=NO,DEFAULT=NO,FORCED=NO,` +
        `URI="${subPlaylistUrl(s.language)}"`
      );
    })
    .join("\n");

  // Insert the media declarations right after the #EXTM3U header line.
  if (/^#EXTM3U[^\r\n]*\r?\n/m.test(out)) {
    return out.replace(/^(#EXTM3U[^\r\n]*\r?\n)/m, `$1${mediaLines}\n`);
  }
  return `${mediaLines}\n${out}`;
}

/**
 * Master playlist. Fetches the upstream `/{guid}/playlist.m3u8` and rewrites
 * each sub-playlist reference (e.g. `360p/video.m3u8`) into a URL that
 * routes back through this proxy with the MAT preserved.
 */
mediaRoutes.get("/video/hls/:videoId/master.m3u8", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const mat = c.req.query("mat");
  const guid = await authorizeProxyRequest(mat, videoId);

  const upstream = bunnyUrl(`/${guid}/playlist.m3u8`);
  const res = await fetch(upstream);
  if (!res.ok) {
    throw AppError.internal(`Bunny returned ${res.status} for master playlist`);
  }
  const body = await res.text();

  const base = proxyBaseUrl(c, videoId);
  const matEnc = encodeURIComponent(mat!);

  // Sub-playlists are referenced as `<quality>/video.m3u8` — single line
  // per variant, no leading `#`.
  const variantRewritten = body.replace(
    /^([^\s#][^\r\n]*\.m3u8)\s*$/gm,
    (line) => {
      const trimmed = line.trim();
      const quality = trimmed.split("/")[0]!;
      return `${base}/v/${encodeURIComponent(quality)}?mat=${matEnc}`;
    },
  );

  // Add subtitle renditions from video_subtitles so the native player's CC
  // menu offers them. Bunny's own captions aren't referenced by the proxied
  // manifest, so we declare + serve them ourselves (MAT-signed, VTT from S3).
  const subs = await db
    .select({ language: videoSubtitles.language, label: videoSubtitles.label })
    .from(videoSubtitles)
    .where(eq(videoSubtitles.videoId, videoId));
  const rewritten = injectSubtitleRenditions(
    variantRewritten,
    subs,
    (lang) => `${base}/subs/${encodeURIComponent(lang)}/playlist.m3u8?mat=${matEnc}`,
  );

  c.header("Content-Type", "application/vnd.apple.mpegurl");
  c.header("Cache-Control", "no-store");
  return c.body(rewritten);
});

/**
 * Sub-playlist for a specific quality. Fetches `/{guid}/{quality}/video.m3u8`
 * upstream and rewrites every segment URL to route through this proxy.
 */
mediaRoutes.get("/video/hls/:videoId/v/:quality", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const quality = c.req.param("quality");
  // Defensive: only allow a small known set of variant names.
  if (!/^[0-9]{2,4}p$/.test(quality)) {
    throw AppError.badRequest("Invalid quality variant");
  }
  const mat = c.req.query("mat");
  const guid = await authorizeProxyRequest(mat, videoId);

  const upstream = bunnyUrl(`/${guid}/${quality}/video.m3u8`);
  const res = await fetch(upstream);
  if (!res.ok) {
    throw AppError.internal(`Bunny returned ${res.status} for ${quality} sub-playlist`);
  }
  const body = await res.text();

  const base = proxyBaseUrl(c, videoId);
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
mediaRoutes.get("/video/hls/:videoId/s", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
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

  const guid = await authorizeProxyRequest(mat, videoId);
  const upstream = bunnyUrl(`/${guid}/${segPath}`);
  return c.redirect(upstream, 302);
});

/**
 * Subtitle sub-playlist — a one-segment WebVTT playlist wrapping the VTT for a
 * single language, referenced by the master playlist's SUBTITLES rendition.
 */
mediaRoutes.get("/video/hls/:videoId/subs/:lang/playlist.m3u8", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const lang = c.req.param("lang");
  if (!/^[a-z]{2,8}$/i.test(lang)) throw AppError.badRequest("Invalid subtitle language");
  const mat = c.req.query("mat");
  await authorizeProxyRequest(mat, videoId);

  const [sub] = await db
    .select({ language: videoSubtitles.language })
    .from(videoSubtitles)
    .where(and(eq(videoSubtitles.videoId, videoId), eq(videoSubtitles.language, lang)))
    .limit(1);
  if (!sub) throw AppError.notFound("Subtitle track not found");

  const [video] = await db
    .select({ durationSeconds: eventVideos.durationSeconds })
    .from(eventVideos)
    .where(eq(eventVideos.id, videoId))
    .limit(1);
  // One VTT covers the whole video; TARGETDURATION just needs to be >= it.
  const dur = Math.max(1, Math.ceil(video?.durationSeconds ?? 86400));
  const base = proxyBaseUrl(c, videoId);
  const matEnc = encodeURIComponent(mat!);

  const playlist =
    [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      `#EXT-X-TARGETDURATION:${dur}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      `#EXTINF:${dur}.0,`,
      `${base}/subs/${encodeURIComponent(lang)}/track.vtt?mat=${matEnc}`,
      "#EXT-X-ENDLIST",
    ].join("\n") + "\n";

  c.header("Content-Type", "application/vnd.apple.mpegurl");
  c.header("Cache-Control", "no-store");
  return c.body(playlist);
});

/**
 * Subtitle VTT — serves the WebVTT for one language from S3 (video_subtitles),
 * MAT-authorized like the rest of the proxy.
 */
mediaRoutes.get("/video/hls/:videoId/subs/:lang/track.vtt", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const lang = c.req.param("lang");
  if (!/^[a-z]{2,8}$/i.test(lang)) throw AppError.badRequest("Invalid subtitle language");
  const mat = c.req.query("mat");
  await authorizeProxyRequest(mat, videoId);

  const [sub] = await db
    .select({ s3Key: videoSubtitles.s3Key })
    .from(videoSubtitles)
    .where(and(eq(videoSubtitles.videoId, videoId), eq(videoSubtitles.language, lang)))
    .limit(1);
  if (!sub?.s3Key) throw AppError.notFound("Subtitle track not found");

  const vtt = await getObjectText(sub.s3Key);
  c.header("Content-Type", "text/vtt; charset=utf-8");
  c.header("Cache-Control", "no-store");
  return c.body(vtt);
});

/**
 * GET /api/media/video/:videoId/download?quality=720p
 *
 * Token-signed direct-MP4 URL for downloading a recording to local storage.
 * Picks the best available variant ≤ requested quality (low-res sources may
 * not have a 720p variant). Requires "MP4 Fallback" enabled on the Bunny
 * library.
 */
mediaRoutes.get("/video/:videoId/download", async (c) => {
  const videoId = parseInt(c.req.param("videoId"), 10);
  const authUser = getOptionalUser(c);
  const qualityParam = (c.req.query("quality") ?? "720p") as BunnyResolution;
  const allowed: ReadonlySet<string> = new Set([
    "240p", "360p", "480p", "720p", "1080p", "1440p", "2160p",
  ]);
  if (!allowed.has(qualityParam)) {
    throw AppError.badRequest("invalid quality");
  }

  const result = await getVideoForPlayback(videoId);
  if (!result?.video) throw AppError.notFound("Video not found");

  if (result.event) {
    const userForAccess = await getUserForAccess(authUser);
    const accessResult = await checkEventAccess(userForAccess, result.event);
    if (!accessResult.allowed) denialToHttpError(accessResult.reason);
  }

  const meta = await getVideoMeta(result.video.bunnyVideoId);
  const available = parseAvailableResolutions(meta.availableResolutions);
  const chosen = bestAvailableResolution(qualityParam, available);
  if (!chosen) {
    throw AppError.notFound("No downloadable variant available for this video");
  }

  const { url, expiresAt } = buildMp4DownloadUrl(result.video.bunnyVideoId, chosen);
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
  const watermarkedPdfBytes = await watermarkPdf(originalPdfBytes, watermarkText);

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

/**
 * Minimal extension → MIME map for documents we serve. Falls back to the
 * object's stored S3 Content-Type, then application/octet-stream.
 */
const FILE_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp", svg: "image/svg+xml",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * GET /api/media/file/:id — serve a generic event document.
 * Requires auth (same event access check as transcripts). Sensitive PDFs are
 * watermarked per-user; everything else is streamed through the API (not a
 * presigned-S3 redirect) so the web app can fetch() it with its auth header and
 * read the blob without needing S3-side CORS. ?download=true forces attachment.
 */
mediaRoutes.get("/file/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const authUser = getOptionalUser(c);
  if (!authUser) throw AppError.unauthorized("Authentication required to view files");

  const result = await getEventForFile(id);
  if (!result?.file) throw AppError.notFound("File not found");

  if (result.event) {
    const userForAccess = await getUserForAccess(authUser);
    const accessResult = await checkEventAccess(userForAccess, result.event);
    if (!accessResult.allowed) denialToHttpError(accessResult.reason);
  }

  const ext = (result.file.extension || "").replace(/^\./, "").toLowerCase();
  const isPdf = ext === "pdf";
  const isDownload = c.req.query("download") === "true";
  const rawFilename = result.file.originalFilename;
  const asciiFilename = rawFilename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  const utf8Filename = encodeURIComponent(rawFilename);

  // Sensitive PDFs → per-user watermark (same treatment as transcripts).
  if (isPdf && result.file.sensitive) {
    const fullUser = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
    const userName = fullUser
      ? [fullUser.firstName, fullUser.lastName].filter(Boolean).join(" ") || authUser.email
      : authUser.email;
    const presignedUrl = await generatePresignedDownloadUrl(result.file.s3Key);
    const pdfResponse = await fetch(presignedUrl);
    if (!pdfResponse.ok) throw AppError.internal("Failed to fetch file from storage");
    const bytes = await watermarkPdf(
      new Uint8Array(await pdfResponse.arrayBuffer()),
      `${userName} — ${authUser.email}`,
    );
    const disposition = isDownload ? "attachment" : "inline";
    return new Response(bytes as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`,
        "Content-Length": String(bytes.byteLength),
      },
    });
  }

  // Everything else → stream the bytes through the API rather than redirecting
  // to S3. Keeping the response on our own origin lets the web app fetch() it
  // with its Authorization header and read the resulting blob; a presigned-S3
  // redirect would require S3-side CORS for the app origin. Pipe S3's body
  // (don't buffer the whole file into memory).
  const presignedUrl = await generatePresignedDownloadUrl(result.file.s3Key);
  const s3Response = await fetch(presignedUrl);
  if (!s3Response.ok || !s3Response.body) {
    throw AppError.internal("Failed to fetch file from storage");
  }
  const contentType =
    FILE_CONTENT_TYPES[ext] ||
    s3Response.headers.get("Content-Type") ||
    "application/octet-stream";
  const disposition = isDownload ? "attachment" : "inline";
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`,
  };
  const contentLength = s3Response.headers.get("Content-Length");
  if (contentLength) headers["Content-Length"] = contentLength;
  return new Response(s3Response.body, { headers });
});

export { mediaRoutes };
