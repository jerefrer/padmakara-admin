import { authFetch } from "./authFetch";

/**
 * Load an existing avatar/hero back into the crop dialog.
 *
 * This goes through our own API rather than fetching the image URL directly:
 * legacy `photoUrl`/`logoUrl` values point at third-party sites that send no
 * CORS headers, so the browser renders them in an `<img>` but refuses to let
 * `fetch()` read the bytes. The API resolves the source server-side and hands
 * back the bytes same-origin. See src/lib/image-source.ts.
 */
export async function fetchImageSourceAsFile(
  path: string,
  filename: string,
): Promise<File> {
  const res = await authFetch(path, { cache: "no-store" });
  if (!res.ok) {
    console.error("[fetchImageSourceAsFile] HTTP", res.status, res.statusText, "path:", path);
    throw new Error(`HTTP ${res.status}`);
  }
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/jpeg" });
}
