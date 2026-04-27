#!/usr/bin/env bun
/**
 * Migrate existing video files from S3 to Bunny Stream.
 *
 * Strategy
 * --------
 * Videos sit in S3 today at `events/{eventCode}/video/*.mp4` in the
 * production bucket. The app can't play them — `tracks.bunnyVideoId` is null.
 * This script reads each video object from S3, uploads it to Bunny via TUS,
 * and attaches the resulting GUID to the matching `sessions` row.
 *
 * The S3 object is NOT deleted. We keep originals in S3 as the master copy.
 *
 * Session matching
 * ----------------
 * Each video file maps to one session. The script's heuristic:
 *   1. Parse the eventCode from the S3 key.
 *   2. Look up the event by eventCode.
 *   3. If the event has exactly ONE session → attach the video to it.
 *   4. If the event has MULTIPLE sessions → match by filename keywords
 *      (Day 1, Day 2, Morning, etc.) against session.titleEn / sessionDate.
 *   5. If matching is ambiguous → log and skip; admin reviews/maps manually.
 *   6. If no session exists yet for the event → create one named after the
 *      file, sessionNumber = nextAvailable, sessionDate = null.
 *
 * Resumability
 * ------------
 * Progress is written to `migration-videos-state.json` after each video.
 * Re-running the script skips already-migrated videos. If a video already
 * has a `bunnyVideoId` on its session, the script skips it.
 *
 * Usage
 * -----
 *   bun src/scripts/migrate-videos-to-bunny.ts                # dry-run
 *   bun src/scripts/migrate-videos-to-bunny.ts --apply        # actually do it
 *   bun src/scripts/migrate-videos-to-bunny.ts --apply --only events/202205-KPS-JC-ENS-COV/video/foo.mp4
 *
 * Env vars: needs the same Bunny + AWS credentials as the API server.
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { sessions } from "../db/schema/sessions.ts";
import { config } from "../config.ts";
import { createVideo, getVideoMeta } from "../services/bunny.ts";

const STATE_FILE = path.resolve(process.cwd(), "migration-videos-state.json");
const VIDEO_KEY_RE = /^events\/([^/]+)\/video\/(.+\.(?:mp4|mov|m4v|mkv|webm))$/i;
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min per video

interface MigrationState {
  /** Map of S3 key -> result of the last attempt. */
  processed: Record<string, {
    s3Key: string;
    eventCode: string;
    sessionId: number | null;
    bunnyVideoId: string | null;
    status: "ok" | "skipped" | "error";
    reason?: string;
    completedAt: string;
  }>;
}

function loadState(): MigrationState {
  if (!fs.existsSync(STATE_FILE)) return { processed: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { processed: {} };
  }
}

function saveState(state: MigrationState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function parseS3Key(key: string): { eventCode: string; filename: string } | null {
  const m = key.match(VIDEO_KEY_RE);
  if (!m) return null;
  return { eventCode: m[1]!, filename: m[2]! };
}

/**
 * Pick the best session for a given filename within an event.
 * Returns the session id, or null if it can't decide unambiguously.
 */
async function pickSession(eventId: number, filename: string): Promise<{
  sessionId: number | null;
  reason: string;
}> {
  const eventSessions = await db.query.sessions.findMany({
    where: eq(sessions.eventId, eventId),
  });

  if (eventSessions.length === 0) {
    return { sessionId: null, reason: "no sessions exist for this event" };
  }
  if (eventSessions.length === 1) {
    return { sessionId: eventSessions[0]!.id, reason: "only one session in event" };
  }

  // Multiple sessions — try filename keyword match.
  const lower = filename.toLowerCase();

  // Day N
  const dayMatch = lower.match(/day[ _-]?(\d+)/);
  if (dayMatch) {
    const n = parseInt(dayMatch[1]!, 10);
    const candidate = eventSessions.find((s) => s.sessionNumber === n);
    if (candidate) return { sessionId: candidate.id, reason: `matched Day ${n}` };
  }

  // ISO date
  const dateMatch = lower.match(/(\d{4})[._-](\d{2})[._-](\d{2})/);
  if (dateMatch) {
    const target = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    const candidate = eventSessions.find((s) => s.sessionDate === target);
    if (candidate) return { sessionId: candidate.id, reason: `matched date ${target}` };
  }

  // Title substring (e.g. "Bodhicitta", "Refuge")
  for (const s of eventSessions) {
    const title = (s.titleEn ?? "").toLowerCase();
    if (title && lower.includes(title)) {
      return { sessionId: s.id, reason: `title substring "${title}"` };
    }
  }

  return {
    sessionId: null,
    reason: `ambiguous — ${eventSessions.length} sessions, no keyword match in filename`,
  };
}

async function uploadFromS3ToBunny(args: {
  s3: S3Client;
  bucket: string;
  key: string;
  filename: string;
  fileSize: number;
}): Promise<{ guid: string; durationSeconds: number }> {
  const { s3, bucket, key, filename, fileSize } = args;

  // 1. Create the Bunny video entry.
  console.log(`  Creating Bunny video: ${filename}`);
  const { guid } = await createVideo(filename);

  // 2. Stream the S3 object straight into Bunny's direct upload endpoint.
  //    No /tmp staging; no TUS bookkeeping. If the upload errors we'll
  //    retry the whole file on the next script run (idempotent — the state
  //    file remembers we never finished this key).
  console.log(`  Streaming S3 -> Bunny: ${(fileSize / 1024 / 1024).toFixed(0)} MB`);
  const s3Response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!s3Response.Body) throw new Error(`S3 returned no body for ${key}`);
  const s3Stream = s3Response.Body as Readable;

  // Light progress logging.
  let bytesPiped = 0;
  let lastLogged = 0;
  s3Stream.on("data", (chunk: Buffer | string) => {
    bytesPiped += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    const pct = (bytesPiped / fileSize) * 100;
    if (pct - lastLogged >= 5) {
      lastLogged = pct;
      process.stdout.write(`\r    ...${pct.toFixed(0)}% (${(bytesPiped / 1024 / 1024).toFixed(0)} MB)   `);
    }
  });

  // Convert Node Readable -> Web ReadableStream so undici/fetch can consume it.
  const webStream = Readable.toWeb(s3Stream) as unknown as ReadableStream<Uint8Array>;

  const uploadUrl = `https://video.bunnycdn.com/library/${config.bunny.libraryId}/videos/${guid}`;
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      AccessKey: config.bunny.apiKey,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(fileSize),
    },
    body: webStream,
    // duplex required by undici when streaming a request body
    ...{ duplex: "half" },
  } as RequestInit);
  process.stdout.write("\n");
  if (!uploadResponse.ok) {
    throw new Error(`Bunny PUT ${uploadResponse.status}: ${await uploadResponse.text()}`);
  }

  // 3. Poll for transcoding to finish so we can capture duration.
  console.log(`  Waiting for Bunny to finish transcoding...`);
  const start = Date.now();
  while (true) {
    const meta = await getVideoMeta(guid);
    if (meta.status === 5 || meta.status === 6) {
      throw new Error(`Bunny transcoding failed (status ${meta.status})`);
    }
    if (meta.status >= 4) {
      return { guid, durationSeconds: Math.round(meta.length || 0) };
    }
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      // Don't fail — webhook will backfill duration. Return 0 for now.
      console.log(`  Transcoding still running after 30 min — webhook will backfill duration`);
      return { guid, durationSeconds: 0 };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const onlyIdx = args.indexOf("--only");
  const onlyKey = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

  if (!apply) {
    console.log("DRY RUN — pass --apply to actually migrate. Showing what would happen:\n");
  }

  const bucket = config.aws.s3Bucket;
  const s3 = new S3Client({
    region: config.aws.region,
    credentials: {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
    },
  });

  // 1. Enumerate all video objects in the production bucket.
  console.log(`Listing videos in s3://${bucket}/events/*/video/...`);
  const allKeys: { key: string; size: number }[] = [];
  let continuationToken: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "events/",
      ContinuationToken: continuationToken,
    }));
    for (const obj of res.Contents ?? []) {
      if (obj.Key && obj.Size && parseS3Key(obj.Key)) {
        if (onlyKey && obj.Key !== onlyKey) continue;
        allKeys.push({ key: obj.Key, size: obj.Size });
      }
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  const totalBytes = allKeys.reduce((sum, k) => sum + k.size, 0);
  console.log(`Found ${allKeys.length} video files, ${(totalBytes / 1024 / 1024 / 1024).toFixed(1)} GB total\n`);

  const state = loadState();
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const { key, size } of allKeys) {
    const parsed = parseS3Key(key)!;
    console.log(`\n=== ${parsed.eventCode} :: ${parsed.filename} (${(size / 1024 / 1024).toFixed(0)} MB) ===`);

    // Skip if we've already processed this key successfully.
    const prior = state.processed[key];
    if (prior?.status === "ok") {
      console.log(`  Already migrated to Bunny ${prior.bunnyVideoId} on ${prior.completedAt} — skipping`);
      skipped++;
      continue;
    }

    // 2. Look up the event.
    const event = await db.query.events.findFirst({
      where: eq(events.eventCode, parsed.eventCode),
    });
    if (!event) {
      console.log(`  No event with eventCode "${parsed.eventCode}" — skipping`);
      state.processed[key] = {
        s3Key: key, eventCode: parsed.eventCode, sessionId: null, bunnyVideoId: null,
        status: "skipped", reason: "event not found", completedAt: new Date().toISOString(),
      };
      saveState(state);
      skipped++;
      continue;
    }

    // 3. Pick a session.
    const { sessionId, reason } = await pickSession(event.id, parsed.filename);
    if (!sessionId) {
      console.log(`  Cannot pick session: ${reason} — skipping (resolve manually then re-run)`);
      state.processed[key] = {
        s3Key: key, eventCode: parsed.eventCode, sessionId: null, bunnyVideoId: null,
        status: "skipped", reason: `no session: ${reason}`, completedAt: new Date().toISOString(),
      };
      saveState(state);
      skipped++;
      continue;
    }
    console.log(`  Target session: id=${sessionId} (${reason})`);

    // 4. Skip if the session already has a video.
    const existingSession = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
    if (existingSession?.bunnyVideoId) {
      console.log(`  Session ${sessionId} already has bunnyVideoId=${existingSession.bunnyVideoId} — skipping`);
      state.processed[key] = {
        s3Key: key, eventCode: parsed.eventCode, sessionId, bunnyVideoId: existingSession.bunnyVideoId,
        status: "skipped", reason: "session already has a video", completedAt: new Date().toISOString(),
      };
      saveState(state);
      skipped++;
      continue;
    }

    if (!apply) {
      console.log(`  [dry-run] Would upload to Bunny and set sessions.bunnyVideoId on session ${sessionId}`);
      continue;
    }

    // 5. Upload.
    try {
      const { guid, durationSeconds } = await uploadFromS3ToBunny({
        s3, bucket, key, filename: parsed.filename, fileSize: size,
      });

      // 6. Patch the session row.
      await db.update(sessions)
        .set({ bunnyVideoId: guid, videoDurationSeconds: durationSeconds || null, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));

      console.log(`  Done: bunny=${guid} duration=${durationSeconds}s -> session ${sessionId}`);
      state.processed[key] = {
        s3Key: key, eventCode: parsed.eventCode, sessionId, bunnyVideoId: guid,
        status: "ok", completedAt: new Date().toISOString(),
      };
      saveState(state);
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED: ${msg}`);
      state.processed[key] = {
        s3Key: key, eventCode: parsed.eventCode, sessionId, bunnyVideoId: null,
        status: "error", reason: msg, completedAt: new Date().toISOString(),
      };
      saveState(state);
      failed++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  State file: ${STATE_FILE}`);
  if (!apply) console.log(`\n(dry run — pass --apply to actually migrate)`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
