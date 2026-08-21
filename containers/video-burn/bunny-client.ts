/**
 * Minimal Bunny Stream API client for the burn container.
 *
 * The container is a separate deployable with its own dependency graph — it
 * cannot import backend code — so this reimplements the two Bunny calls it
 * needs, mirroring src/services/bunny.ts exactly. Keep these in sync by
 * hand if that file's request/response shapes ever change.
 */

export interface BunnyConfig {
  libraryId: string;
  apiKey: string;
}

export interface FetchVideoResult {
  guid: string;
}

/**
 * Pull a video into Bunny Stream from a source URL. Mirrors fetchVideo() in
 * src/services/bunny.ts — same request shape, same "guid may be absent,
 * fall back to id" handling.
 */
export async function fetchVideo(
  bunny: BunnyConfig,
  sourceUrl: string,
  title: string,
): Promise<FetchVideoResult> {
  const url = `https://video.bunnycdn.com/library/${bunny.libraryId}/videos/fetch`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      AccessKey: bunny.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ url: sourceUrl, title }),
  });
  if (!response.ok) {
    throw new Error(`Bunny fetch ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as { guid?: string; id?: string };
  const guid = data.guid ?? data.id;
  if (!guid) throw new Error(`Bunny fetch returned no guid: ${JSON.stringify(data)}`);
  return { guid };
}

/**
 * Set a video's poster thumbnail by handing Bunny a URL to fetch it from —
 * same "point Bunny at a presigned S3 URL" shape as fetchVideo() above.
 *
 * There is no time-offset field on the video object to have Bunny pick a
 * frame itself: verified against docs.bunny.net's Update Video and Set
 * Thumbnail reference pages — only a direct image upload or a
 * `thumbnailUrl` fetch are supported, no `thumbnailTime`. Hence the
 * explicit-extract-and-upload approach used by the caller (see
 * computeThumbnailOffsetSeconds in ffmpeg-plan.ts).
 */
export async function setThumbnail(
  bunny: BunnyConfig,
  videoGuid: string,
  thumbnailUrl: string,
): Promise<void> {
  const url = `https://video.bunnycdn.com/library/${bunny.libraryId}/videos/${videoGuid}/thumbnail?thumbnailUrl=${encodeURIComponent(thumbnailUrl)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { AccessKey: bunny.apiKey, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Bunny set-thumbnail ${response.status}: ${await response.text()}`);
  }
}
