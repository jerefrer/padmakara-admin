/**
 * Resolves which master-recording source this burn job uses.
 *
 * Exactly one of two env vars is set per job (see submitVideoBurnJob in
 * src/services/video-burn.ts):
 *
 *  - MASTER_S3_KEY — the browser already PUT the master to S3 (the normal
 *    admin-upload gate). The container downloads it directly.
 *  - MASTER_SOURCE_URL — a pasted URL (Drive share link or public direct
 *    link) with slides attached (POST /admin/videos/import-url). The
 *    container downloads the file itself and retains the untouched original
 *    in S3 (video-burn/{videoId}/master{ext}) before burning, so re-burns
 *    still have a first-generation master — see entrypoint.ts's main().
 *
 * Both set, or neither set, is a job misconfiguration rather than a runtime
 * condition to recover from — it throws instead of guessing.
 */

export type MasterSource = { kind: "s3Key"; key: string } | { kind: "url"; url: string };

export function resolveMasterSource(env: {
  MASTER_S3_KEY?: string;
  MASTER_SOURCE_URL?: string;
}): MasterSource {
  const s3Key = env.MASTER_S3_KEY?.trim() || undefined;
  const sourceUrl = env.MASTER_SOURCE_URL?.trim() || undefined;

  if (s3Key && sourceUrl) {
    throw new Error(
      "Both MASTER_S3_KEY and MASTER_SOURCE_URL are set — a burn job must have exactly one master source",
    );
  }
  if (!s3Key && !sourceUrl) {
    throw new Error(
      "Neither MASTER_S3_KEY nor MASTER_SOURCE_URL is set — a burn job needs exactly one master source",
    );
  }

  return s3Key ? { kind: "s3Key", key: s3Key } : { kind: "url", url: sourceUrl! };
}
