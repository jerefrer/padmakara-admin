import { config } from "../config.ts";
import { AppError } from "../lib/errors.ts";

/**
 * Turn admin-pasted video links into URLs Bunny Stream's `/videos/fetch`
 * endpoint can actually download.
 *
 * Google Drive share links serve an HTML preview page, not the file, and the
 * naive `uc?export=download` form hits a virus-scan interstitial for files
 * over ~100 MB — so Drive links are rewritten to a direct-download form:
 *
 *   - With a Google API key configured (GOOGLE_API_KEY): the documented
 *     Drive v3 `alt=media` URL. Requires the file to be shared as
 *     "Anyone with the link".
 *   - Without a key: the drive.usercontent.google.com download URL with
 *     `confirm=t`, which skips the interstitial for link-shared files.
 *     Undocumented but stable in practice.
 *
 * Any other http(s) URL is passed through untouched — the server never
 * fetches it itself (Bunny does), so there is no SSRF surface here beyond
 * the Drive metadata call to googleapis.com.
 */

export interface ResolvedVideoSource {
  /** URL to hand to Bunny's fetch endpoint. */
  sourceUrl: string;
  /** Google Drive file ID when the input was a Drive file link, else null. */
  driveFileId: string | null;
}

export interface DriveFileMeta {
  name: string;
  mimeType: string;
  size: number | null;
}

/**
 * Extract the file ID from any of the common Google Drive file-link shapes.
 * Returns null for non-Drive URLs and for Drive *folder* links (those are
 * rejected with a clearer message by resolveVideoSourceUrl).
 */
export function parseDriveFileId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const host = url.hostname;
  const isDriveHost =
    host === "drive.google.com" ||
    host === "docs.google.com" ||
    host === "drive.usercontent.google.com";
  if (!isDriveHost) return null;

  // https://drive.google.com/file/d/{id}[/view|/edit...]
  const pathMatch = url.pathname.match(/^\/file\/d\/([\w-]+)/);
  if (pathMatch) return pathMatch[1]!;

  // https://drive.google.com/open?id={id}
  // https://drive.google.com/uc?id={id}&export=download
  // https://docs.google.com/uc?id={id}
  // https://drive.usercontent.google.com/download?id={id}
  if (["/open", "/uc", "/download"].includes(url.pathname)) {
    const id = url.searchParams.get("id");
    if (id && /^[\w-]+$/.test(id)) return id;
  }

  return null;
}

/**
 * Resolve an admin-pasted URL to a Bunny-fetchable direct-download URL.
 * Throws AppError.badRequest for anything that can't work (bad URL, wrong
 * scheme, Drive folder link).
 */
export function resolveVideoSourceUrl(
  rawUrl: string,
  apiKey: string = config.google.apiKey,
): ResolvedVideoSource {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw AppError.badRequest("Not a valid URL", "INVALID_URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw AppError.badRequest("URL must use http or https", "INVALID_URL");
  }

  if (url.hostname === "drive.google.com" && url.pathname.startsWith("/drive/folders/")) {
    throw AppError.badRequest(
      "This is a Google Drive folder link — paste a link to a single video file instead",
      "DRIVE_FOLDER_LINK",
    );
  }

  const driveFileId = parseDriveFileId(rawUrl);
  if (!driveFileId) {
    return { sourceUrl: rawUrl, driveFileId: null };
  }

  const sourceUrl = apiKey
    ? `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media&key=${apiKey}`
    : `https://drive.usercontent.google.com/download?id=${driveFileId}&export=download&confirm=t`;

  return { sourceUrl, driveFileId };
}

/**
 * Check a Drive file exists and is publicly downloadable, and return its
 * metadata (used for the default video title). Only callable when a Google
 * API key is configured — without one we hand the URL to Bunny untested.
 */
export async function validateDriveFile(
  fileId: string,
  apiKey: string = config.google.apiKey,
): Promise<DriveFileMeta> {
  if (!apiKey) {
    throw new Error("validateDriveFile requires a Google API key");
  }

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size&key=${apiKey}`,
  );

  if (!response.ok) {
    if (response.status === 404 || response.status === 403) {
      throw AppError.badRequest(
        "Google Drive file not found or not public — set its sharing to \"Anyone with the link\" and try again",
        "DRIVE_FILE_NOT_ACCESSIBLE",
      );
    }
    throw new Error(`Google Drive API ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as { name: string; mimeType: string; size?: string };

  // Google-native docs (Docs/Sheets/folders…) have no downloadable binary.
  if (data.mimeType.startsWith("application/vnd.google-apps.")) {
    throw AppError.badRequest(
      "This Drive link is not a downloadable file (it's a Google Docs/folder item) — link a video file instead",
      "DRIVE_NOT_A_FILE",
    );
  }

  return {
    name: data.name,
    mimeType: data.mimeType,
    size: data.size ? parseInt(data.size, 10) : null,
  };
}
