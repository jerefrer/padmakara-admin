import { createHash } from "node:crypto";

/**
 * A device fingerprint obtains session tokens, so it is a credential: the
 * database keeps only its SHA-256 (hex), in `device_activations` and
 * `magic_link_tokens`. Every lookup hashes its input first. Values already
 * stored are hashes and are copied as they are (e.g. from a magic link row to
 * the device activation), never hashed a second time.
 */
export function hashDeviceFingerprint(fingerprint: string): string {
  return createHash("sha256").update(fingerprint, "utf8").digest("hex");
}

/**
 * Fingerprints made by app builds after build 46: 32 random bytes, base64url
 * without padding (exactly 43 characters). Older builds send base64 of a JSON
 * object of device info (over 100 characters), `${platform}-${time}-${random}`
 * or a short string hash, none of which can match.
 */
const CURRENT_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function isCurrentFingerprintFormat(fingerprint: string): boolean {
  return CURRENT_FORMAT.test(fingerprint);
}
