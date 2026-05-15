import { createHash } from "node:crypto";
import { config } from "../config.ts";

/**
 * Bunny Stream token-authenticated playback URLs.
 *
 * Two distinct token formats are needed depending on URL flavor:
 *
 * 1. CDN token (HLS playlist + segments + thumbnail + MP4 fallback)
 *      Used when "CDN Token Authentication" is enabled on the library.
 *      Format: base64url(sha256(securityKey + tokenPath + expires))
 *      URL:    https://{cdn}{filePath}?token={t}&expires={e}&token_path={tokenPath}
 *      A *path-based* token (token_path = "/{videoId}/") authorises every
 *      file under that prefix so HLS players can fetch the playlist AND
 *      every .ts segment with one signature.
 *      Reference: https://docs.bunny.net/docs/cdn-token-authentication
 *
 * 2. Embed view token (iframe URL only)
 *      Used when "Embed view token authentication" is enabled on the library.
 *      Format: base64url(sha256(libraryId + securityKey + expires + videoGuid))
 *      URL:    https://iframe.mediadelivery.net/embed/{libraryId}/{guid}?token={t}&expires={e}
 *      Note: different ordering, includes libraryId, no path component.
 *      Reference: https://docs.bunny.net/docs/stream-embedding-videos
 *
 * Both formats use the same library "Token authentication key".
 */

interface PlaybackUrls {
  hls: string;
  iframe: string;
  thumbnail: string;
  expiresAt: number;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Sign a CDN path-prefix with the library's Token Authentication Key.
 *
 * Returns a token that authorises every file under `tokenPath`. Used for HLS
 * (where the player fetches the playlist *and* segments under /{videoId}/)
 * and for any other CDN-served file under the same prefix.
 */
export function signCdnPath(tokenPath: string, expires: number): string {
  if (!config.bunny.tokenAuthKey) {
    throw new Error("BUNNY_STREAM_TOKEN_AUTH_KEY is not configured");
  }
  if (!tokenPath.startsWith("/")) {
    throw new Error(`Bunny signed path must start with "/", got: ${tokenPath}`);
  }
  const hash = createHash("sha256")
    .update(config.bunny.tokenAuthKey + tokenPath + expires)
    .digest();
  return base64url(hash);
}

// Backwards-compat alias for the old name. Prefer signCdnPath.
export const signBunnyPath = signCdnPath;

/**
 * Sign the iframe-embed token.
 *
 * Verified empirically against this Bunny library — the embed view token is
 * the hex SHA-256 of `securityKey + videoGuid + expires`. No libraryId in the
 * hash, hex (not base64url) output. Bunny's public docs describe a different
 * shape for some libraries, so this may differ per pull zone — if a future
 * library 403s the iframe URL, brute-force a few orderings as we did here.
 */
function signEmbedView(_libraryId: string, videoId: string, expires: number): string {
  if (!config.bunny.tokenAuthKey) {
    throw new Error("BUNNY_STREAM_TOKEN_AUTH_KEY is not configured");
  }
  return createHash("sha256")
    .update(config.bunny.tokenAuthKey + videoId + expires)
    .digest("hex");
}

/**
 * Build signed playback URLs for a Bunny Stream video.
 *
 * Returns the HLS playlist URL (for native expo-video / standard HLS players),
 * the iframe embed URL (for web fallback), and a thumbnail URL. All URLs share
 * the same expiration so the client can cache them as a unit.
 */
export function buildPlaybackUrls(videoId: string, ttlSeconds?: number): PlaybackUrls {
  if (!config.bunny.cdnHostname) {
    throw new Error("BUNNY_STREAM_CDN_HOSTNAME is not configured");
  }
  if (!config.bunny.libraryId) {
    throw new Error("BUNNY_STREAM_LIBRARY_ID is not configured");
  }
  if (!videoId) {
    throw new Error("videoId is required");
  }

  const ttl = ttlSeconds ?? config.bunny.playbackTtlSeconds;
  const expires = Math.floor(Date.now() / 1000) + ttl;

  // CDN tokens are exact-URL only on this pull zone — token_path / path-prefix
  // tokens are rejected. Each URL signs its own path. The master playlist works
  // with this scheme; sub-playlists and segments require either the iframe
  // player (auto-signs internally) or the MP4 fallback URL (single file).
  const playlistPath = `/${videoId}/playlist.m3u8`;
  const playlistToken = signCdnPath(playlistPath, expires);
  const hls = `https://${config.bunny.cdnHostname}${playlistPath}?token=${playlistToken}&expires=${expires}`;

  const thumbPath = `/${videoId}/thumbnail.jpg`;
  const thumbToken = signCdnPath(thumbPath, expires);
  const thumbnail = `https://${config.bunny.cdnHostname}${thumbPath}?token=${thumbToken}&expires=${expires}`;

  // Iframe embed URL — separate signing scheme, see file-level comment.
  const iframeToken = signEmbedView(config.bunny.libraryId, videoId, expires);
  const iframe = `https://iframe.mediadelivery.net/embed/${config.bunny.libraryId}/${videoId}?token=${iframeToken}&expires=${expires}`;

  return { hls, iframe, thumbnail, expiresAt: expires };
}

/**
 * Build a token-signed direct-MP4 URL for offline download.
 *
 * Requires "MP4 Fallback" to be enabled on the Bunny library. The path
 * pattern is `/{videoId}/play_{quality}.mp4` and is signed with the same
 * token-authentication scheme as the HLS playlist.
 *
 * Default quality is 720p — large enough to look good, small enough that a
 * 1-hour video lands around 1 GB instead of 3 GB. Caller can request a
 * different ladder if the library has multiple variants.
 */
export function buildMp4DownloadUrl(
  videoId: string,
  quality: BunnyResolution = '720p',
  ttlSeconds = 3 * 60 * 60, // 3h — leaves headroom for slow connections
): { url: string; expiresAt: number } {
  if (!config.bunny.cdnHostname) {
    throw new Error('BUNNY_STREAM_CDN_HOSTNAME is not configured');
  }
  if (!videoId) {
    throw new Error('videoId is required');
  }
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const path = `/${videoId}/play_${quality}.mp4`;
  const token = signCdnPath(path, expires);
  return {
    url: `https://${config.bunny.cdnHostname}${path}?token=${token}&expires=${expires}`,
    expiresAt: expires,
  };
}

/**
 * Bunny Stream video metadata returned by their API.
 * Subset we care about — full schema: https://docs.bunny.net/reference/video_getvideo
 */
export type BunnyResolution = '240p' | '360p' | '480p' | '720p' | '1080p' | '1440p' | '2160p';

export interface BunnyVideoMeta {
  guid: string;
  title: string;
  status: number; // 0 created · 1 uploaded · 2 processing · 3 transcoding · 4 finished · 5 error
  length: number; // duration in seconds (0 until transcoding completes)
  width: number;
  height: number;
  framerate: number;
  thumbnailFileName: string | null;
  /**
   * Comma-separated list of resolutions actually produced by Bunny, e.g.
   * "240p,360p,480p". Source videos below 720p won't have a 720p variant.
   * Bunny returns this as a string in the API; we keep it raw here and parse
   * it where we use it.
   */
  availableResolutions: string | null;
}

const RESOLUTION_ORDER: readonly BunnyResolution[] = [
  '240p', '360p', '480p', '720p', '1080p', '1440p', '2160p',
];

/**
 * Parse Bunny's `availableResolutions` string into the resolutions actually
 * produced for this video. Older or low-res source files won't have higher
 * variants — e.g. a 480p source produces only 240p/360p/480p.
 */
export function parseAvailableResolutions(raw: string | null | undefined): BunnyResolution[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is BunnyResolution => (RESOLUTION_ORDER as readonly string[]).includes(s));
}

/**
 * Pick the best available resolution ≤ the requested target.
 * Returns null if no variant meets the constraint.
 *
 * Example: requested=720p, available=[240p, 360p, 480p] → returns "480p".
 * Example: requested=720p, available=[720p, 1080p] → returns "720p".
 * Example: requested=720p, available=[] → returns null (nothing transcoded yet).
 */
export function bestAvailableResolution(
  requested: BunnyResolution,
  available: readonly BunnyResolution[],
): BunnyResolution | null {
  const requestedIdx = RESOLUTION_ORDER.indexOf(requested);
  if (requestedIdx === -1) return null;
  let best: { res: BunnyResolution; idx: number } | null = null;
  for (const res of available) {
    const idx = RESOLUTION_ORDER.indexOf(res);
    if (idx === -1 || idx > requestedIdx) continue;
    if (!best || idx > best.idx) best = { res, idx };
  }
  return best?.res ?? null;
}

/**
 * Fetch metadata for a video from Bunny Stream's API.
 * Used by the admin UI after upload to populate duration / poster on the track row.
 */
export async function getVideoMeta(videoId: string): Promise<BunnyVideoMeta> {
  if (!config.bunny.libraryId || !config.bunny.apiKey) {
    throw new Error("Bunny Stream API credentials are not configured");
  }
  const url = `https://video.bunnycdn.com/library/${config.bunny.libraryId}/videos/${videoId}`;
  const response = await fetch(url, {
    headers: {
      AccessKey: config.bunny.apiKey,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Bunny API ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as BunnyVideoMeta;
}

/**
 * Create a video entry in Bunny Stream and return its GUID.
 * The actual file upload is a follow-up PUT to the upload endpoint —
 * the admin UI does that directly from the browser using this GUID.
 */
export async function createVideo(title: string): Promise<{ guid: string }> {
  if (!config.bunny.libraryId || !config.bunny.apiKey) {
    throw new Error("Bunny Stream API credentials are not configured");
  }
  const url = `https://video.bunnycdn.com/library/${config.bunny.libraryId}/videos`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      AccessKey: config.bunny.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    throw new Error(`Bunny API ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as { guid: string };
  return { guid: data.guid };
}

/**
 * Generate a TUS upload signature for resumable browser-side uploads.
 *
 * The browser uses tus-js-client to upload directly to Bunny's TUS endpoint
 * (`https://video.bunnycdn.com/tusupload`) with these headers:
 *
 *   AuthorizationSignature: <signature>
 *   AuthorizationExpire:    <expirationTime>
 *   VideoId:                <videoId>
 *   LibraryId:              <libraryId>
 *
 * Signature: hex(sha256(libraryId + apiKey + expirationTime + videoId))
 * Reference: https://docs.bunny.net/reference/tus-resumable-uploads
 */
export interface TusUploadCredentials {
  endpoint: string;
  videoId: string;
  libraryId: string;
  signature: string;
  expirationTime: number;
}

export function buildTusCredentials(videoId: string, ttlSeconds = 3600): TusUploadCredentials {
  if (!config.bunny.libraryId || !config.bunny.apiKey) {
    throw new Error("Bunny Stream API credentials are not configured");
  }
  if (!videoId) {
    throw new Error("videoId is required");
  }
  const expirationTime = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = createHash("sha256")
    .update(config.bunny.libraryId + config.bunny.apiKey + expirationTime + videoId)
    .digest("hex");
  return {
    endpoint: "https://video.bunnycdn.com/tusupload",
    videoId,
    libraryId: config.bunny.libraryId,
    signature,
    expirationTime,
  };
}

/**
 * Delete a video from Bunny Stream. Used when an admin removes a track row —
 * we don't want orphaned videos racking up storage cost.
 */
export async function deleteVideo(videoId: string): Promise<void> {
  if (!config.bunny.libraryId || !config.bunny.apiKey) {
    throw new Error("Bunny Stream API credentials are not configured");
  }
  const url = `https://video.bunnycdn.com/library/${config.bunny.libraryId}/videos/${videoId}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: { AccessKey: config.bunny.apiKey },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Bunny API ${response.status}: ${await response.text()}`);
  }
}
