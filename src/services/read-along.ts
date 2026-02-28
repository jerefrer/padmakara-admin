import { BatchClient, SubmitJobCommand } from "@aws-sdk/client-batch";
import { eq, desc } from "drizzle-orm";
import { db } from "../db/index.ts";
import { readAlongJobs } from "../db/schema/read-along-jobs.ts";
import { events } from "../db/schema/retreats.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import { config } from "../config.ts";
import { AppError } from "../lib/errors.ts";

const batchClient = new BatchClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

interface SubmitOptions {
  language?: string;
  skipPages?: number;
  whisperModel?: string;
}

/**
 * Submit a read-along alignment job for an event.
 * Creates a DB job record and submits to AWS Batch.
 */
export async function submitReadAlongJob(
  eventId: number,
  options: SubmitOptions = {},
) {
  // Verify event exists and has what we need
  const event = await db.query.events.findFirst({
    where: eq(events.id, eventId),
  });
  if (!event) throw AppError.notFound("Event not found");

  // Check for transcript to determine language
  const transcript = await db.query.transcripts.findFirst({
    where: eq(transcripts.eventId, eventId),
  });

  const language = options.language ?? transcript?.language ?? "en";
  const skipPages = options.skipPages ?? 7;
  const whisperModel = options.whisperModel ?? "turbo";

  // Create job record
  const [job] = await db
    .insert(readAlongJobs)
    .values({
      eventId,
      language,
      skipPages,
      whisperModel,
      status: "pending",
    })
    .returning();

  // Build webhook URL
  const webhookUrl = `${config.urls.backend}/api/webhooks/read-along`;

  // Submit to AWS Batch
  const command = new SubmitJobCommand({
    jobName: `read-along-${event.eventCode}`,
    jobDefinition: config.readAlong.jobDefinition,
    jobQueue: config.readAlong.jobQueue,
    containerOverrides: {
      environment: [
        { name: "EVENT_CODE", value: event.eventCode },
        { name: "EVENT_ID", value: String(eventId) },
        { name: "JOB_ID", value: job!.id },
        { name: "S3_BUCKET", value: config.aws.s3Bucket },
        { name: "LANGUAGE", value: language },
        { name: "SKIP_PAGES", value: String(skipPages) },
        { name: "WHISPER_MODEL", value: whisperModel },
        { name: "WEBHOOK_URL", value: webhookUrl },
        { name: "WEBHOOK_SECRET", value: config.readAlong.webhookSecret },
      ],
    },
  });

  const response = await batchClient.send(command);

  // Update job with Batch job ID
  await db
    .update(readAlongJobs)
    .set({
      batchJobId: response.jobId,
      status: "submitted",
      submittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(readAlongJobs.id, job!.id));

  return {
    jobId: job!.id,
    batchJobId: response.jobId,
    status: "submitted",
    eventCode: event.eventCode,
    language,
    skipPages,
    whisperModel,
  };
}

/**
 * Get recent read-along jobs for an event.
 */
export async function getReadAlongJobs(eventId: number) {
  return db.query.readAlongJobs.findMany({
    where: eq(readAlongJobs.eventId, eventId),
    orderBy: [desc(readAlongJobs.createdAt)],
    limit: 10,
  });
}
