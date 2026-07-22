import { BatchClient, DescribeJobsCommand } from "@aws-sdk/client-batch";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { readAlongJobs } from "../db/schema/read-along-jobs.ts";
import { subtitleJobs } from "../db/schema/subtitle-jobs.ts";
import { config } from "../config.ts";

const batchClient = new BatchClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

// DescribeJobs accepts at most 100 job IDs per call.
const DESCRIBE_JOBS_CHUNK_SIZE = 100;

// SUCCEEDED jobs get a grace period before we conclude the completion
// webhook was lost — the container may have finished and the webhook POST
// may simply not have arrived (or landed) yet.
const SUCCEEDED_WEBHOOK_GRACE_MS = 2 * 60 * 1000;

// A submitted/queued/running row whose batchJobId AWS Batch no longer knows
// about (aged out of its retention window) is presumed dead only once it's
// had a reasonable chance to actually be running — otherwise we'd race a
// job that was submitted moments ago and hasn't shown up in DescribeJobs yet.
const AGED_OUT_THRESHOLD_MS = 15 * 60 * 1000;

const TERMINAL_DB_STATUSES = new Set(["completed", "failed"]);

export interface BatchJobInfo {
  status: string;
  statusReason?: string;
  containerReason?: string;
  exitCode?: number;
  stoppedAt?: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Look up the current AWS Batch state for a set of job IDs, keyed by job ID.
 * Exported (rather than inlined) so tests can mock the AWS SDK cleanly.
 */
export async function describeBatchJobs(
  jobIds: string[],
): Promise<Map<string, BatchJobInfo>> {
  const result = new Map<string, BatchJobInfo>();
  if (jobIds.length === 0) return result;

  for (const batch of chunk(jobIds, DESCRIBE_JOBS_CHUNK_SIZE)) {
    const response = await batchClient.send(
      new DescribeJobsCommand({ jobs: batch }),
    );
    for (const job of response.jobs ?? []) {
      if (!job.jobId || !job.status) continue;
      result.set(job.jobId, {
        status: job.status,
        statusReason: job.statusReason,
        containerReason: job.container?.reason,
        exitCode: job.container?.exitCode,
        stoppedAt: job.stoppedAt,
      });
    }
  }

  return result;
}

interface NextState {
  status: string;
  errorMessage?: string | null;
  completedAt?: Date;
}

/**
 * Map an AWS Batch job's current state onto the DB job's next state, given
 * the row's current status. Returns null when nothing should change.
 */
function computeNextState(
  row: { status: string; submittedAt: Date | null },
  jobInfo: BatchJobInfo | undefined,
  now: number,
): NextState | null {
  if (!jobInfo) {
    // Aged out of AWS Batch's retention window — final status unknowable.
    // Only conclude this once the job has had a reasonable chance to have
    // been picked up at all, to avoid racing a just-submitted job.
    if (
      row.submittedAt &&
      now - row.submittedAt.getTime() > AGED_OUT_THRESHOLD_MS
    ) {
      return {
        status: "failed",
        errorMessage:
          "Job no longer tracked by AWS Batch (aged out); final status unknown — re-run if needed.",
        completedAt: new Date(),
      };
    }
    return null;
  }

  switch (jobInfo.status) {
    case "FAILED": {
      const errorMessage =
        jobInfo.statusReason ||
        jobInfo.containerReason ||
        (jobInfo.exitCode != null
          ? `container exited ${jobInfo.exitCode}`
          : null) ||
        "Batch job failed";
      return {
        status: "failed",
        errorMessage,
        completedAt: jobInfo.stoppedAt ? new Date(jobInfo.stoppedAt) : new Date(),
      };
    }
    case "SUCCEEDED": {
      if (
        jobInfo.stoppedAt &&
        now - jobInfo.stoppedAt > SUCCEEDED_WEBHOOK_GRACE_MS
      ) {
        return {
          status: "failed",
          errorMessage:
            "Batch job succeeded but its completion callback was never received — re-run to finish processing.",
          completedAt: new Date(),
        };
      }
      // Still within the grace window — the webhook may yet land.
      return null;
    }
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
 * The subset of a Drizzle table's shape reconcileJobs needs to issue an
 * update. `table`/`idCol` are used directly; the remaining column refs are
 * accepted for interface completeness (both read_along_jobs and
 * subtitle_jobs share identical field names for these columns, so the
 * update payload below uses the literal field names rather than the column
 * objects themselves — Drizzle's `.set()` keys on the table's JS property
 * names, not the runtime Column instances).
 */
export interface ReconcileTable {
  table: any;
  idCol: any;
  statusCol: any;
  batchIdCol: any;
  errorCol: any;
  submittedAtCol: any;
  completedAtCol: any;
  updatedAtCol: any;
}

/**
 * Reconcile a batch of non-terminal job rows against AWS Batch's actual
 * state, updating the DB where reality has diverged. Never touches rows
 * that are already completed/failed, and never throws — a broken AWS call
 * must not prevent the caller from returning whatever the DB already has.
 */
export async function reconcileJobs(
  rows: any[],
  t: ReconcileTable,
): Promise<void> {
  const nonTerminal = rows.filter(
    (r) => !TERMINAL_DB_STATUSES.has(r.status) && Boolean(r.batchJobId),
  );
  if (nonTerminal.length === 0) return;

  try {
    const info = await describeBatchJobs(
      nonTerminal.map((r) => r.batchJobId as string),
    );
    const now = Date.now();

    for (const row of nonTerminal) {
      const jobInfo = info.get(row.batchJobId as string);
      const next = computeNextState(row, jobInfo, now);
      if (!next || next.status === row.status) continue;

      const updatePayload: Record<string, unknown> = {
        status: next.status,
        updatedAt: new Date(),
      };
      if (next.errorMessage !== undefined) {
        updatePayload.errorMessage = next.errorMessage;
      }
      if (next.completedAt !== undefined) {
        updatePayload.completedAt = next.completedAt;
      }

      await db.update(t.table).set(updatePayload).where(eq(t.idCol, row.id));
    }
  } catch (err) {
    console.error(
      "[batch-reconcile] Failed to reconcile jobs against AWS Batch:",
      err,
    );
  }
}

export async function reconcileReadAlongRows(rows: any[]): Promise<void> {
  await reconcileJobs(rows, {
    table: readAlongJobs,
    idCol: readAlongJobs.id,
    statusCol: readAlongJobs.status,
    batchIdCol: readAlongJobs.batchJobId,
    errorCol: readAlongJobs.errorMessage,
    submittedAtCol: readAlongJobs.submittedAt,
    completedAtCol: readAlongJobs.completedAt,
    updatedAtCol: readAlongJobs.updatedAt,
  });
}

export async function reconcileSubtitleRows(rows: any[]): Promise<void> {
  await reconcileJobs(rows, {
    table: subtitleJobs,
    idCol: subtitleJobs.id,
    statusCol: subtitleJobs.status,
    batchIdCol: subtitleJobs.batchJobId,
    errorCol: subtitleJobs.errorMessage,
    submittedAtCol: subtitleJobs.submittedAt,
    completedAtCol: subtitleJobs.completedAt,
    updatedAtCol: subtitleJobs.updatedAt,
  });
}
