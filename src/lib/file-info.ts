/**
 * Original file name of a video master. Masters are stored as
 * `events/<code>/masters/<Date.now()>-<original name>`; the numeric prefix
 * only keeps keys unique.
 */
export function originalNameFromMasterKey(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  return base.replace(/^\d{10,}-/, "");
}
