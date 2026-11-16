import { getObjectBytes } from "../services/s3.ts";
import { AppError } from "./errors.ts";
import { safeFetch, SafeFetchError } from "./safe-fetch.ts";

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

/**
 * The legacy URLs we fetch come from our own database and are only writable
 * by admins, but they are still data rather than code — so the fetch goes
 * through safeFetch (./safe-fetch.ts), which refuses anything that is, or
 * resolves or redirects to, a non-public address. Plain http stays allowed:
 * some legacy values inherited from the Django site may still be http, and
 * it is the address checks, not the scheme, that stop SSRF.
 */
const FETCH_TIMEOUT_MS = 15_000;
/** Far above any real avatar/logo; stops a hostile host streaming forever. */
export const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;

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
    try {
      const res = await safeFetch(source.fallbackUrl, {
        allowHttp: true,
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_IMAGE_SOURCE_BYTES,
        acceptContentType: (type) => type.startsWith("image/"),
      });
      return { body: res.body, contentType: res.contentType };
    } catch (err) {
      if (err instanceof SafeFetchError && err.reason === "blocked") {
        throw AppError.badRequest(`Stored image URL refused: ${err.message}`, "INVALID_IMAGE_URL");
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new AppError(502, `Could not fetch source image (${detail})`, "IMAGE_SOURCE_UNAVAILABLE");
    }
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
