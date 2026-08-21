import { getObjectBytes } from "../services/s3.ts";
import { AppError } from "./errors.ts";

/**
 * Serving an existing avatar/hero back to the admin UI so it can be
 * re-cropped.
 *
 * The admin used to `fetch()` the image URL straight from the browser, but
 * that only works when the host sends CORS headers. Our own object storage
 * does; the legacy third-party `photo_url` / `logo_url` values inherited from
 * the Django site (khyentsevision.org, dalailama.com, …) do not — an `<img>`
 * tag renders them fine, but `fetch()` is blocked, which is why re-cropping
 * those records failed. Fetching the bytes server-side removes the browser's
 * cross-origin constraint entirely, whatever the source turns out to be.
 */
export interface ImageSource {
  body: Uint8Array;
  contentType: string;
}

/** Hosts we refuse to fetch server-side (SSRF guard, see below). */
const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0", "[::1]", "::1"]);

const PRIVATE_IPV4 =
  /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * The URLs we fetch come from our own database and are only writable by
 * admins, but they are still data rather than code — so keep the server from
 * being turned into a proxy onto the internal network.
 */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.badRequest("Stored image URL is not a valid URL", "INVALID_IMAGE_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw AppError.badRequest("Stored image URL is not http(s)", "INVALID_IMAGE_URL");
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".local") || PRIVATE_IPV4.test(host)) {
    throw AppError.badRequest("Stored image URL points at a private host", "INVALID_IMAGE_URL");
  }
  return url;
}

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Resolve an image to raw bytes, preferring our own storage and falling back
 * to the legacy external URL. Throws 404 when the record has neither.
 */
export async function loadImageSource(source: {
  s3Key: string | null | undefined;
  fallbackUrl: string | null | undefined;
}): Promise<ImageSource> {
  if (source.s3Key) {
    return await getObjectBytes(source.s3Key);
  }

  if (source.fallbackUrl) {
    const url = assertFetchableUrl(source.fallbackUrl);
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new AppError(
        502,
        `Could not fetch source image (HTTP ${res.status})`,
        "IMAGE_SOURCE_UNAVAILABLE",
      );
    }
    return {
      body: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") || "application/octet-stream",
    };
  }

  throw AppError.notFound("No image to edit");
}

/** Hand the bytes back to the browser; never cached, it's an editing source. */
export function imageSourceResponse(image: ImageSource): Response {
  // Cast: TS types Uint8Array as ArrayBufferLike-backed, which doesn't satisfy
  // BodyInit's ArrayBuffer-backed view, but a Uint8Array is a valid body at runtime.
  return new Response(image.body as unknown as BodyInit, {
    headers: {
      "Content-Type": image.contentType,
      "Cache-Control": "no-store",
    },
  });
}
