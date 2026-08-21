import { BatchClient, SubmitJobCommand } from "@aws-sdk/client-batch";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { eventVideos } from "../db/schema/event-videos.ts";
import { videoProgress } from "../db/schema/video-progress.ts";
import { videoSubtitles } from "../db/schema/video-subtitles.ts";
import { config } from "../config.ts";
import { putObject, storageEnvForContainer } from "./s3.ts";
import { describeBatchJobs, type BatchJobInfo } from "./batch-reconcile.ts";
import type { SlideDocument } from "../lib/slides/types.ts";

const batchClient = new BatchClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

/**
 * Exactly one master source per job:
 *  - `masterS3Key` — the browser already PUT the master to S3 (the normal
 *    admin-upload gate). The container downloads it directly.
 *  - `masterSourceUrl` — a pasted URL (Drive share link or public direct
 *    link) with slides attached (see POST /admin/videos/import-url). The
 *    container downloads the file itself and retains the untouched
 *    original in S3 before burning, so re-burns still have a
 *    first-generation master — see containers/video-burn/source.ts.
 */
export type VideoBurnSource =
  | { masterS3Key: string; masterSourceUrl?: undefined }
  | { masterS3Key?: undefined; masterSourceUrl: string };

export type SubmitVideoBurnOptions = VideoBurnSource & {
  videoId: number;
  slides: SlideDocument;
  title: string;
};

export interface SubmitVideoBurnResult {
  jobId: string;
}

/**
 * Submit a title-slide burn-in job for an event_video.
 * Mirrors submitSubtitleJob (subtitles.ts) / submitReadAlongJob (read-along.ts).
 *
 * The slide document is written to S3 first and only its key is passed to
 * the container — AWS Batch caps containerOverrides at 8192 bytes total,
 * which a slide document with several image lines can exceed. Same
 * precedent as AUDIO_KEYS_S3_KEY in read-along.ts.
 */
export async function submitVideoBurnJob(
  options: SubmitVideoBurnOptions,
): Promise<SubmitVideoBurnResult> {
  const { videoId, slides, title } = options;

  const slidesS3Key = `video-burn/${videoId}/slides.json`;
  await putObject(
    slidesS3Key,
    Buffer.from(JSON.stringify(slides)),
    "application/json",
  );

  const outputS3Key = `video-burn/${videoId}/merged.mp4`;
  const webhookUrl = `${config.urls.backend}/api/webhooks/video-burn`;

  // JOB_ID is a per-attempt identifier for logging/webhook correlation —
  // unlike subtitle_jobs/read_along_jobs there is no dedicated jobs table
  // for burns (the lifecycle lives directly on event_videos), so there is
  // no DB row id to reuse the way those two services do.
  const jobId = crypto.randomUUID();

  // The `masterSourceUrl` branch is guaranteed a string here by
  // VideoBurnSource's union — only masterS3Key is ever missing/present the
  // other way around — but TS doesn't narrow a sibling property from a
  // truthy check on this one, hence the assertion.
  const sourceEnvVar = options.masterS3Key
    ? { name: "MASTER_S3_KEY", value: options.masterS3Key }
    : { name: "MASTER_SOURCE_URL", value: options.masterSourceUrl as string };

  const command = new SubmitJobCommand({
    jobName: `video-burn-${videoId}`,
    jobDefinition: config.videoBurn.jobDefinition,
    jobQueue: config.videoBurn.jobQueue,
    containerOverrides: {
      environment: [
        ...storageEnvForContainer(),
        { name: "JOB_ID", value: jobId },
        { name: "VIDEO_ID", value: String(videoId) },
        sourceEnvVar,
        { name: "SLIDES_S3_KEY", value: slidesS3Key },
        { name: "OUTPUT_S3_KEY", value: outputS3Key },
        { name: "S3_BUCKET", value: config.storage.bucket },
        { name: "TITLE", value: title },
        { name: "WEBHOOK_URL", value: webhookUrl },
        { name: "WEBHOOK_SECRET", value: config.readAlong.webhookSecret },
      ],
    },
  });

  const response = await batchClient.send(command);
  if (!response.jobId) {
    throw new Error("AWS Batch SubmitJobCommand returned no jobId");
  }

  await db
    .update(eventVideos)
    .set({
      burnJobId: response.jobId,
      burnStatus: "queued",
      burnError: null,
      updatedAt: new Date(),
    })
    .where(eq(eventVideos.id, videoId));

  return { jobId: response.jobId };
}

// ─── Reconciliation ─────────────────────────────────────────────────────

/**
 * Terminal burn_status values — reconciliation never touches these rows.
 * Mirrors TERMINAL_DB_STATUSES in batch-reconcile.ts.
 */
const TERMINAL_BURN_STATUSES = new Set(["done", "failed"]);

// Same thresholds as batch-reconcile.ts (SUCCEEDED_WEBHOOK_GRACE_MS /
// AGED_OUT_THRESHOLD_MS), duplicated rather than imported because they are
// module-private constants there.
const SUCCEEDED_WEBHOOK_GRACE_MS = 2 * 60 * 1000;
const AGED_OUT_THRESHOLD_MS = 15 * 60 * 1000;

export interface EventVideoBurnRow {
  id: number;
  burnStatus: string;
  burnJobId: string | null;
  /**
   * Stands in for read_along_jobs/subtitle_jobs' dedicated submittedAt
   * column — event_videos has none. submitVideoBurnJob() bumps updatedAt
   * every time it (re)submits a job, and nothing else touches a row while
   * its burn is in flight, so it is a faithful proxy for "when was this
   * attempt submitted".
   */
  updatedAt: Date;
}

interface NextBurnState {
  status: string;
  errorMessage?: string | null;
}

function computeNextBurnState(
  row: EventVideoBurnRow,
  jobInfo: BatchJobInfo | undefined,
  now: number,
): NextBurnState | null {
  if (!jobInfo) {
    if (now - row.updatedAt.getTime() > AGED_OUT_THRESHOLD_MS) {
      return {
        status: "failed",
        errorMessage:
          "Job no longer tracked by AWS Batch (aged out); final status unknown — re-run if needed.",
      };
    }
    return null;
  }

  switch (jobInfo.status) {
    case "FAILED": {
      const errorMessage =
        jobInfo.statusReason ||
        jobInfo.containerReason ||
        (jobInfo.exitCode != null ? `container exited ${jobInfo.exitCode}` : null) ||
        "Batch job failed";
      return { status: "failed", errorMessage };
    }
    case "SUCCEEDED": {
      if (jobInfo.stoppedAt && now - jobInfo.stoppedAt > SUCCEEDED_WEBHOOK_GRACE_MS) {
        return {
          status: "failed",
          errorMessage:
            "Batch job succeeded but its completion callback was never received — re-run to finish processing.",
        };
      }
      return null;
    }
    // "running" (not "processing") to match event_videos.burn_status's
    // documented lifecycle: none | pending | queued | running | done | failed.
    case "RUNNING":
    case "STARTING":
      return { status: "running" };
    case "RUNNABLE":
      return { status: "queued" };
    case "SUBMITTED":
    case "PENDING":
      return null;
    default:
      return null;
  }
}

/**
 * Reconcile non-terminal event_videos burn rows against AWS Batch's real
 * state — same contract as reconcileJobs in batch-reconcile.ts (never
 * touches terminal rows, never throws, swallows AWS errors).
 *
 * Not built on the shared reconcileJobs() helper directly: that helper's
 * update payload hardcodes the field names `status` / `errorMessage` /
 * `completedAt`, which match subtitle_jobs and read_along_jobs but not
 * event_videos' burn_status / burn_error columns — and event_videos has no
 * dedicated submittedAt/completedAt columns (see EventVideoBurnRow above).
 * describeBatchJobs() itself IS reused, since it has no such coupling.
 */
export async function reconcileVideoBurnRows(rows: EventVideoBurnRow[]): Promise<void> {
  const nonTerminal = rows.filter(
    (r) => !TERMINAL_BURN_STATUSES.has(r.burnStatus) && Boolean(r.burnJobId),
  );
  if (nonTerminal.length === 0) return;

  try {
    const info = await describeBatchJobs(nonTerminal.map((r) => r.burnJobId as string));
    const now = Date.now();

    for (const row of nonTerminal) {
      const jobInfo = info.get(row.burnJobId as string);
      const next = computeNextBurnState(row, jobInfo, now);
      if (!next || next.status === row.burnStatus) continue;

      await db
        .update(eventVideos)
        .set({
          burnStatus: next.status,
          burnError: next.errorMessage ?? null,
          updatedAt: new Date(),
        })
        .where(eq(eventVideos.id, row.id));
    }
  } catch (err) {
    console.error("[video-burn] Failed to reconcile burn jobs against AWS Batch:", err);
  }
}

// ─── Re-burn intro-length desync ────────────────────────────────────────
//
// A re-burn can change the intro's length (a slide added/removed, a
// duration edited). Everything timed against the OLD merged timeline —
// saved resume positions and existing subtitle cues — is then off by
// exactly that delta. These pure helpers compute the delta and the clamped
// shift; the webhook route (src/routes/webhooks.ts) applies the same
// semantics as a single bulk SQL UPDATE inside a transaction alongside the
// event_videos row update, rather than looping per-row through
// shiftPositionSeconds — the function below exists to make that SQL's
// intended behavior explicit and independently testable.

export interface IntroDeltaResult {
  deltaMs: number;
  changed: boolean;
}

/**
 * Delta between a re-burn's new intro length and the previous one.
 * `previousIntroMs === null` means this is the FIRST successful burn for
 * this video — there is no prior timeline to have desynced, so the delta
 * is defined as zero/unchanged rather than `newIntroMs - 0`.
 */
export function computeIntroDelta(
  previousIntroMs: number | null,
  newIntroMs: number,
): IntroDeltaResult {
  if (previousIntroMs === null) return { deltaMs: 0, changed: false };
  const deltaMs = newIntroMs - previousIntroMs;
  return { deltaMs, changed: deltaMs !== 0 };
}

/**
 * Shift one stored resume position by an intro-length delta (ms), clamped
 * at 0 (can't resume before the start) and, when a known duration is
 * available, at that duration (can't resume past the end).
 */
export function shiftPositionSeconds(
  positionSeconds: number,
  deltaMs: number,
  durationSeconds?: number | null,
): number {
  // `video_progress.position_seconds` is an INTEGER column, and the bulk SQL
  // in applyIntroDeltaInTransaction adds a whole-second delta. Round here the
  // same way, or this function would document behaviour the shipped query
  // does not implement — a sub-second intro change rounds to no shift at all.
  const shifted = positionSeconds + Math.round(deltaMs / 1000);
  const clampedLow = Math.max(0, shifted);
  if (durationSeconds != null) return Math.min(clampedLow, durationSeconds);
  return clampedLow;
}

/**
 * Apply the delta to every video_progress row for a video (bulk SQL, not
 * a per-row loop — see the file-level comment above) and flag every
 * video_subtitles row for that video as stale, since existing VTT cues are
 * absolute-timed from the start of the merged video and cannot be
 * auto-corrected. No-op when the delta is zero (including a first burn).
 * Runs inside `tx` so it commits atomically with the event_videos update
 * the caller makes in the same transaction.
 */
export async function applyIntroDeltaInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  videoId: number,
  deltaMs: number,
): Promise<void> {
  if (deltaMs === 0) return;
  const deltaSeconds = Math.round(deltaMs / 1000);

  await tx
    .update(videoProgress)
    .set({
      // Mirrors shiftPositionSeconds()'s clamping in SQL: clamp at 0, and
      // at the row's own duration when known.
      positionSeconds: sql`GREATEST(0, LEAST(COALESCE(${videoProgress.durationSeconds}, 2147483647), ${videoProgress.positionSeconds} + ${deltaSeconds}))`,
      updatedAt: new Date(),
    })
    .where(eq(videoProgress.videoId, videoId));

  await tx
    .update(videoSubtitles)
    .set({ stale: true, updatedAt: new Date() })
    .where(eq(videoSubtitles.videoId, videoId));
}
