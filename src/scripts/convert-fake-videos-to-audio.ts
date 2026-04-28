#!/usr/bin/env bun
/**
 * Convert audio-only-in-video-wrapper files to actual audio tracks.
 *
 * Two passes:
 *
 * Pass A — "Fake video" Bunny entries
 *   Walks every Bunny Stream video; if framerate <= 5 the source was an
 *   audio recording packaged with a static image. Pulls the original MP4
 *   from S3, extracts a 128 kbps MP3, uploads to the event's audio/ folder,
 *   creates a track row, NULLs out the session's bunny_video_id, deletes the
 *   Bunny entry, and moves the source MP4 to events/{code}/source/.
 *
 * Pass B — Stray .m4a files under video/
 *   Some events have .m4a files in events/{code}/video/ that the original
 *   migration script ignored (it only looks at video extensions). These are
 *   pure audio recordings already; transcode to MP3 for archive format
 *   consistency, attach as track rows, move source to source/.
 *
 * Idempotent. State file at migration-audio-extraction-state.json. Dry-run by
 * default; requires --apply to mutate. ffmpeg must be on PATH.
 */

import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable, PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { eq, and } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";
import { config } from "../config.ts";
import { deleteVideo } from "../services/bunny.ts";

const STATE_FILE = path.resolve(process.cwd(), "migration-audio-extraction-state.json");
const MIGRATION_STATE_FILE = path.resolve(process.cwd(), "migration-videos-state.json");
const FAKE_VIDEO_FRAMERATE_THRESHOLD = 5;

interface AudioState {
  /** Map of S3 audio output key -> result. */
  processed: Record<string, {
    sourceS3Key: string;
    audioS3Key: string;
    eventCode: string;
    sessionId: number | null;
    trackId: number | null;
    bunnyVideoId: string | null;
    pass: "A" | "B";
    status: "ok" | "skipped" | "error";
    reason?: string;
    completedAt: string;
  }>;
}

function loadState(): AudioState {
  if (!fs.existsSync(STATE_FILE)) return { processed: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { processed: {} };
  }
}

function saveState(state: AudioState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadMigrationState(): Record<string, { s3Key: string; bunnyVideoId: string | null }> {
  if (!fs.existsSync(MIGRATION_STATE_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(MIGRATION_STATE_FILE, "utf-8"));
    return raw.processed ?? {};
  } catch {
    return {};
  }
}

/**
 * Extract speaker abbreviation from the filename.
 * "John Canti - Gyu Lama - 17 May 2022.mp4" -> "JC"
 * "KPSR - Gyu Lama - 17 May 2022.mp4"       -> "KPS"
 * Anything else                              -> null
 */
function inferSpeaker(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (lower.startsWith("john canti")) return "JC";
  if (lower.startsWith("kpsr") || lower.startsWith("kps")) return "KPS";
  if (lower.startsWith("jkr")) return "JKR";
  if (lower.startsWith("pwr")) return "PWR";
  if (lower.startsWith("wf") || lower.startsWith("wulstan fletcher")) return "WF";
  return null;
}

/**
 * Build the output audio key from the source video key.
 * events/{code}/video/Foo.mp4 -> events/{code}/audio/Foo.mp3
 */
function audioKeyFromVideoKey(videoKey: string): string {
  const audioKey = videoKey
    .replace("/video/", "/audio/")
    .replace(/\.[^.]+$/, ".mp3");
  return audioKey;
}

function sourceKeyFromVideoKey(videoKey: string): string {
  return videoKey.replace("/video/", "/source/");
}

/**
 * Strip extension and known media-type tags from a filename to derive a
 * clean track title. Mirrors the helper in migrate-videos-to-bunny.ts.
 */
function deriveTitle(filename: string): string {
  let title = filename.replace(/\.[^.]+$/, "");
  title = title.replace(/\[[^\]]*\]/g, "").trim();
  title = title.replace(/[-_\s]+(?:video|audio|eng?|por|fra|tib|fr|en|pt)\b/gi, "").trim();
  title = title.replace(/[_]+/g, " ").replace(/\s+/g, " ").replace(/^[-\s]+|[-\s]+$/g, "");
  return title || filename.replace(/\.[^.]+$/, "");
}

/** Extract YYYY-MM-DD if the filename contains a parseable date. */
function extractIsoDate(filename: string): string | null {
  const isoMatch = filename.match(/(\d{4})[._\-/](\d{1,2})[._\-/](\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]!.padStart(2, "0")}-${isoMatch[3]!.padStart(2, "0")}`;
  }
  const compactMatch = filename.match(/\b(\d{4})(\d{2})(\d{2})\b/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }
  return null;
}

/**
 * Stream S3 source -> ffmpeg -> S3 audio destination.
 *
 * ffmpeg flags: -vn (drop video), -c:a libmp3lame, -b:a 128k, -ar 44100.
 * Both ends are streams so no /tmp staging.
 */
async function transcodeS3ToS3({
  s3,
  bucket,
  sourceKey,
  destKey,
}: {
  s3: S3Client;
  bucket: string;
  sourceKey: string;
  destKey: string;
}): Promise<void> {
  // Pull the source as a stream.
  const srcResponse = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: sourceKey }));
  if (!srcResponse.Body) throw new Error(`S3 returned no body for ${sourceKey}`);
  const srcStream = srcResponse.Body as Readable;

  // Spawn ffmpeg reading stdin, writing stdout.
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel", "warning",
    "-i", "pipe:0",
    "-vn",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-ar", "44100",
    "-f", "mp3",
    "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });

  let ffmpegStderr = "";
  ffmpeg.stderr?.on("data", (chunk) => { ffmpegStderr += chunk.toString(); });

  // Pipe S3 source -> ffmpeg stdin.
  srcStream.pipe(ffmpeg.stdin);
  srcStream.on("error", (err) => {
    ffmpeg.stdin?.destroy(err);
  });

  // ffmpeg stdout -> a passthrough we hand to the S3 multipart upload.
  const passthrough = new PassThrough();
  ffmpeg.stdout?.pipe(passthrough);

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: destKey,
      Body: passthrough,
      ContentType: "audio/mpeg",
    },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
  });

  // Race ffmpeg exit against the upload completion.
  const ffmpegExit = new Promise<void>((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}\nstderr:\n${ffmpegStderr}`));
    });
  });

  await Promise.all([ffmpegExit, upload.done()]);
}

async function moveS3Object(
  s3: S3Client,
  bucket: string,
  fromKey: string,
  toKey: string,
): Promise<void> {
  await s3.send(new CopyObjectCommand({
    Bucket: bucket,
    Key: toKey,
    CopySource: `${bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, "/")}`,
  }));
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: fromKey }));
}

async function getS3ObjectSize(s3: S3Client, bucket: string, key: string): Promise<number> {
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return head.ContentLength ?? 0;
}

/** Find the next free track_number for a session. */
async function nextTrackNumber(sessionId: number): Promise<number> {
  const existing = await db.query.tracks.findMany({ where: eq(tracks.sessionId, sessionId) });
  return existing.reduce((m, t) => Math.max(m, t.trackNumber || 0), 0) + 1;
}

/** Find the next free session_number for an event. */
async function nextSessionNumber(eventId: number): Promise<number> {
  const existing = await db.query.sessions.findMany({ where: eq(sessions.eventId, eventId) });
  return existing.reduce((m, s) => Math.max(m, s.sessionNumber || 0), 0) + 1;
}

interface BunnyVideoLite {
  guid: string;
  title: string;
  framerate: number;
  length: number;
}

async function listBunnyVideos(): Promise<BunnyVideoLite[]> {
  if (!config.bunny.libraryId || !config.bunny.apiKey) {
    throw new Error("Bunny credentials not configured");
  }
  const url = `https://video.bunnycdn.com/library/${config.bunny.libraryId}/videos?itemsPerPage=200`;
  const res = await fetch(url, { headers: { AccessKey: config.bunny.apiKey, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Bunny list failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items: any[] };
  return (data.items ?? []).map((v) => ({
    guid: v.guid,
    title: v.title ?? "",
    framerate: v.framerate ?? 0,
    length: v.length ?? 0,
  }));
}

async function passA_fakeVideos(args: {
  s3: S3Client;
  bucket: string;
  state: AudioState;
  apply: boolean;
}): Promise<{ ok: number; skipped: number; failed: number }> {
  const { s3, bucket, state, apply } = args;
  const out = { ok: 0, skipped: 0, failed: 0 };

  console.log(`\n=== Pass A: Bunny videos with framerate <= ${FAKE_VIDEO_FRAMERATE_THRESHOLD} ===\n`);

  const allBunny = await listBunnyVideos();
  const fakeVideos = allBunny.filter((v) => v.framerate > 0 && v.framerate <= FAKE_VIDEO_FRAMERATE_THRESHOLD);
  console.log(`Found ${fakeVideos.length} Bunny videos at <= ${FAKE_VIDEO_FRAMERATE_THRESHOLD} fps (${allBunny.length} total)\n`);

  const migrationState = loadMigrationState();

  for (const v of fakeVideos) {
    console.log(`--- ${v.guid.slice(0, 8)}  fps=${v.framerate}  length=${v.length}s  '${v.title}'`);

    // 1. Find the session pointing at this GUID.
    const session = await db.query.sessions.findFirst({ where: eq(sessions.bunnyVideoId, v.guid) });
    if (!session) {
      console.log(`    No session in DB references this GUID — skipping`);
      out.skipped++;
      continue;
    }

    // 2. Find the event for path construction.
    const event = await db.query.events.findFirst({ where: eq(events.id, session.eventId) });
    if (!event) {
      console.log(`    Event ${session.eventId} not found — skipping (data inconsistency)`);
      out.skipped++;
      continue;
    }

    // 3. Find the source MP4 from the migration state file (matches by GUID).
    const sourceEntry = Object.values(migrationState).find((e) => e.bunnyVideoId === v.guid);
    if (!sourceEntry || !sourceEntry.s3Key) {
      console.log(`    No source S3 key found in migration state for GUID ${v.guid} — skipping`);
      out.skipped++;
      continue;
    }
    const sourceKey = sourceEntry.s3Key;
    const audioKey = audioKeyFromVideoKey(sourceKey);
    const archivedKey = sourceKeyFromVideoKey(sourceKey);

    // 4. Skip if we already processed this conversion.
    if (state.processed[audioKey]?.status === "ok") {
      console.log(`    Already converted on ${state.processed[audioKey]!.completedAt} — skipping`);
      out.skipped++;
      continue;
    }

    if (!apply) {
      console.log(`    [dry-run] Would: transcode ${sourceKey} -> ${audioKey},`);
      console.log(`              create track row on session ${session.id} '${event.eventCode}',`);
      console.log(`              detach + delete Bunny video ${v.guid},`);
      console.log(`              move source ${sourceKey} -> ${archivedKey}`);
      out.ok++;
      continue;
    }

    try {
      // 5. Transcode: S3 source MP4 -> ffmpeg -> S3 audio MP3.
      console.log(`    Transcoding to ${audioKey} ...`);
      await transcodeS3ToS3({ s3, bucket, sourceKey, destKey: audioKey });
      const audioSize = await getS3ObjectSize(s3, bucket, audioKey);
      console.log(`    Transcoded: ${(audioSize / 1024 / 1024).toFixed(1)} MB`);

      // 6. Insert track row.
      const filename = sourceKey.split("/").pop() ?? "track.mp4";
      const title = deriveTitle(filename);
      const trackNumber = await nextTrackNumber(session.id);
      const speaker = inferSpeaker(filename);
      const [track] = await db.insert(tracks).values({
        sessionId: session.id,
        title,
        trackNumber,
        languages: ["en"],
        originalLanguage: "en",
        isTranslation: false,
        s3Key: audioKey,
        durationSeconds: Math.round(v.length || 0),
        fileSizeBytes: audioSize,
        originalFilename: filename,
        speaker,
        fileFormat: "mp3",
      }).returning();
      if (!track) throw new Error("Failed to insert track row");
      console.log(`    Inserted track ${track.id} #${trackNumber} on session ${session.id}`);

      // 7. NULL out the session's bunny_video_id.
      await db.update(sessions)
        .set({
          bunnyVideoId: null,
          videoDurationSeconds: null,
          videoPosterUrl: null,
          updatedAt: new Date(),
        })
        .where(eq(sessions.id, session.id));

      // 8. Delete the Bunny video.
      await deleteVideo(v.guid);
      console.log(`    Deleted Bunny video ${v.guid}`);

      // 9. Move source MP4 to source/.
      await moveS3Object(s3, bucket, sourceKey, archivedKey);
      console.log(`    Moved ${sourceKey} -> ${archivedKey}`);

      state.processed[audioKey] = {
        sourceS3Key: sourceKey,
        audioS3Key: audioKey,
        eventCode: event.eventCode,
        sessionId: session.id,
        trackId: track.id,
        bunnyVideoId: v.guid,
        pass: "A",
        status: "ok",
        completedAt: new Date().toISOString(),
      };
      saveState(state);
      out.ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    FAILED: ${msg}`);
      state.processed[audioKey] = {
        sourceS3Key: sourceKey,
        audioS3Key: audioKey,
        eventCode: event.eventCode,
        sessionId: session.id,
        trackId: null,
        bunnyVideoId: v.guid,
        pass: "A",
        status: "error",
        reason: msg,
        completedAt: new Date().toISOString(),
      };
      saveState(state);
      out.failed++;
    }
  }

  return out;
}

async function passB_strayM4a(args: {
  s3: S3Client;
  bucket: string;
  state: AudioState;
  apply: boolean;
}): Promise<{ ok: number; skipped: number; failed: number }> {
  const { s3, bucket, state, apply } = args;
  const out = { ok: 0, skipped: 0, failed: 0 };

  console.log(`\n=== Pass B: .m4a files in events/*/video/ folders ===\n`);

  // List all .m4a under events/{code}/video/.
  const m4aKeys: { key: string; eventCode: string }[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: "events/", ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      const m = obj.Key.match(/^events\/([^/]+)\/video\/(.+\.m4a)$/i);
      if (m) m4aKeys.push({ key: obj.Key, eventCode: m[1]! });
    }
    token = res.NextContinuationToken;
  } while (token);

  console.log(`Found ${m4aKeys.length} stray .m4a files\n`);

  for (const { key, eventCode } of m4aKeys) {
    const filename = key.split("/").pop()!;
    console.log(`--- ${eventCode} :: ${filename}`);

    const audioKey = audioKeyFromVideoKey(key);
    const archivedKey = sourceKeyFromVideoKey(key);

    if (state.processed[audioKey]?.status === "ok") {
      console.log(`    Already converted on ${state.processed[audioKey]!.completedAt} — skipping`);
      out.skipped++;
      continue;
    }

    const event = await db.query.events.findFirst({ where: eq(events.eventCode, eventCode) });
    if (!event) {
      console.log(`    Event "${eventCode}" not found — skipping`);
      out.skipped++;
      continue;
    }

    // Pick or create a session for this file. Prefer an existing session
    // whose sessionDate matches a date in the filename.
    const fileDate = extractIsoDate(filename);
    let targetSession: { id: number } | null = null;
    let createdSession = false;
    if (fileDate) {
      const found = await db.query.sessions.findFirst({
        where: and(eq(sessions.eventId, event.id), eq(sessions.sessionDate, fileDate)),
      });
      if (found) targetSession = { id: found.id };
    }

    if (!targetSession) {
      // Auto-create a sibling session for this file.
      if (!apply) {
        console.log(`    [dry-run] Would auto-create session (date=${fileDate ?? "n/a"}, title="${deriveTitle(filename)}")`);
      } else {
        const sn = await nextSessionNumber(event.id);
        const [created] = await db.insert(sessions).values({
          eventId: event.id,
          titleEn: deriveTitle(filename),
          sessionDate: fileDate,
          sessionNumber: sn,
          timePeriod: null,
        }).returning();
        if (!created) {
          console.error(`    Failed to auto-create session — skipping`);
          out.failed++;
          continue;
        }
        targetSession = { id: created.id };
        createdSession = true;
        console.log(`    Auto-created session ${created.id} #${sn}`);
      }
    } else {
      console.log(`    Matched existing session ${targetSession.id} by date ${fileDate}`);
    }

    if (!apply) {
      console.log(`    [dry-run] Would: transcode ${key} -> ${audioKey}, create track row, move source -> ${archivedKey}`);
      out.ok++;
      continue;
    }

    try {
      await transcodeS3ToS3({ s3, bucket, sourceKey: key, destKey: audioKey });
      const audioSize = await getS3ObjectSize(s3, bucket, audioKey);
      console.log(`    Transcoded: ${(audioSize / 1024 / 1024).toFixed(1)} MB -> ${audioKey}`);

      const title = deriveTitle(filename);
      const trackNumber = await nextTrackNumber(targetSession!.id);
      const speaker = inferSpeaker(filename);
      const [track] = await db.insert(tracks).values({
        sessionId: targetSession!.id,
        title,
        trackNumber,
        languages: ["en"],
        originalLanguage: "en",
        isTranslation: false,
        s3Key: audioKey,
        durationSeconds: 0, // we don't probe here; the read-along/api will eventually backfill
        fileSizeBytes: audioSize,
        originalFilename: filename,
        speaker,
        fileFormat: "mp3",
      }).returning();
      if (!track) throw new Error("Failed to insert track row");
      console.log(`    Inserted track ${track.id} #${trackNumber} on session ${targetSession!.id}${createdSession ? " (newly created)" : ""}`);

      await moveS3Object(s3, bucket, key, archivedKey);
      console.log(`    Moved ${key} -> ${archivedKey}`);

      state.processed[audioKey] = {
        sourceS3Key: key,
        audioS3Key: audioKey,
        eventCode,
        sessionId: targetSession!.id,
        trackId: track.id,
        bunnyVideoId: null,
        pass: "B",
        status: "ok",
        completedAt: new Date().toISOString(),
      };
      saveState(state);
      out.ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    FAILED: ${msg}`);
      state.processed[audioKey] = {
        sourceS3Key: key,
        audioS3Key: audioKey,
        eventCode,
        sessionId: targetSession?.id ?? null,
        trackId: null,
        bunnyVideoId: null,
        pass: "B",
        status: "error",
        reason: msg,
        completedAt: new Date().toISOString(),
      };
      saveState(state);
      out.failed++;
    }
  }

  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  if (!apply) {
    console.log("DRY RUN — pass --apply to actually do the work.\n");
  }

  // Quick check: ffmpeg available?
  await new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    p.on("error", () => reject(new Error("ffmpeg not found on PATH — install with: sudo apt install ffmpeg")));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg -version exited ${code}`))));
  });

  const bucket = config.aws.s3Bucket;
  const s3 = new S3Client({
    region: config.aws.region,
    credentials: {
      accessKeyId: config.aws.accessKeyId,
      secretAccessKey: config.aws.secretAccessKey,
    },
  });

  const state = loadState();

  const passA = await passA_fakeVideos({ s3, bucket, state, apply });
  const passB = await passB_strayM4a({ s3, bucket, state, apply });

  console.log(`\n=== Summary ===`);
  console.log(`  Pass A (Bunny audio-as-video): ok=${passA.ok}  skipped=${passA.skipped}  failed=${passA.failed}`);
  console.log(`  Pass B (stray .m4a):           ok=${passB.ok}  skipped=${passB.skipped}  failed=${passB.failed}`);
  console.log(`  State file: ${STATE_FILE}`);
  if (!apply) console.log(`\n(dry run — pass --apply to actually do the work)`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
