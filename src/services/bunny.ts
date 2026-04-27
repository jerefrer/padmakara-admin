import { createHash } from "node:crypto";
import { config } from "../config.ts";

/**
 * Bunny Stream token-authenticated playback URLs.
 *
 * Bunny Stream's "Token Authentication" signs a path + expiry with the library's
 * Token Authentication Key. The resulting URL is only valid until `expires`,
 * and only for the exact path it was signed for — no hotlinking possible.
 *
 * Token format (Bunny CDN token authentication):
 *   token = base64url( SHA256( securityKey + path + expires ) )
 *   url   = `https://{cdnHostname}{path}?token={token}&expires={expires}`
 *
 * Reference: https://docs.bunny.net/docs/cdn-token-authentication
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
 * Sign a Bunny CDN path with the library's Token Authentication Key.
 *
 * @param path     URL path starting with "/" (e.g. "/{videoId}/playlist.m3u8")
 * @param expires  Unix epoch seconds at which the signature stops being valid
 * @returns        URL-safe base64-encoded SHA-256 hash
 */
export function signBunnyPath(path: string, expires: number): string {
  if (!config.bunny.tokenAuthKey) {
    throw new Error("BUNNY_STREAM_TOKEN_AUTH_KEY is not configured");
  }
  if (!path.startsWith("/")) {
    throw new Error(`Bunny signed path must start with "/", got: ${path}`);
  }
  const hash = createHash("sha256")
    .update(config.bunny.tokenAuthKey + path + expires)
    .digest();
  return base64url(hash);
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

  const hlsPath = `/${videoId}/playlist.m3u8`;
  const hlsToken = signBunnyPath(hlsPath, expires);
  const hls = `https://${config.bunny.cdnHostname}${hlsPath}?token=${hlsToken}&expires=${expires}`;

  // Thumbnail uses the same CDN hostname; Bunny generates thumbnail.jpg automatically.
  const thumbPath = `/${videoId}/thumbnail.jpg`;
  const thumbToken = signBunnyPath(thumbPath, expires);
  const thumbnail = `https://${config.bunny.cdnHostname}${thumbPath}?token=${thumbToken}&expires=${expires}`;

  // Iframe embed URL (web fallback). Bunny signs iframe URLs the same way but
  // against the iframe path on iframe.mediadelivery.net — kept for parity but
  // the HLS URL is what the native mobile player consumes.
  const iframe = `https://iframe.mediadelivery.net/embed/${config.bunny.libraryId}/${videoId}?token=${hlsToken}&expires=${expires}`;

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
  quality: '240p' | '360p' | '480p' | '720p' | '1080p' = '720p',
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
  const token = signBunnyPath(path, expires);
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
