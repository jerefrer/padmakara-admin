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

/**
 * Checkpoint per source file. Each step is recorded so re-runs can resume
 * from the last incomplete step without re-doing successful work.
 *   transcoded:        MP3 has been written to S3
 *   trackInserted:     track row exists in DB
 *   bunnyDetached:     session.bunny_video_id NULL'd (Pass A only)
 *   bunnyDeleted:      Bunny video API-deleted (Pass A only)
 *   sourceMoved:       source MP4/M4A moved from video/ -> source/
 */
interface ConversionCheckpoint {
  sourceS3Key: string;
  audioS3Key: string;
  archivedS3Key: string;
  eventCode: string;
  sessionId: number | null;
  trackId: number | null;
  bunnyVideoId: string | null;
  pass: "A" | "B";
  status: "ok" | "skipped" | "error" | "partial";
  reason?: string;
  steps: {
    transcoded: boolean;
    trackInserted: boolean;
    bunnyDetached: boolean;
    bunnyDeleted: boolean;
    sourceMoved: boolean;
  };
  completedAt: string;
}

interface AudioState {
  /** Map of S3 audio output key -> checkpoint. */
  processed: Record<string, ConversionCheckpoint>;
}

function emptySteps(): ConversionCheckpoint["steps"] {
  return {
    transcoded: false,
    trackInserted: false,
    bunnyDetached: false,
    bunnyDeleted: false,
    sourceMoved: false,
  };
}

function loadState(): AudioState {
  if (!fs.existsSync(STATE_FILE)) return { processed: {} };
  let state: AudioState;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { processed: {} };
  }
  // Migrate legacy checkpoints (written before the per-step refactor) that
  // lack a `steps` field. Backfill from `status === "ok"` when possible.
  for (const cp of Object.values(state.processed ?? {})) {
    if (!cp.steps) {
      cp.steps = emptySteps();
      if (cp.status === "ok") {
        cp.steps.transcoded = true;
        cp.steps.trackInserted = !!cp.trackId;
        cp.steps.sourceMoved = true;
        if (cp.pass === "A") {
          cp.steps.bunnyDetached = true;
          cp.steps.bunnyDeleted = true;
        }
      }
    }
    if (!cp.archivedS3Key) {
      cp.archivedS3Key = sourceKeyFromVideoKey(cp.sourceS3Key);
    }
  }
  return state;
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

const MONTHS_EN = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
] as const;

const MONTH_ABBR_EN: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Extract the first plausible YYYY-MM-DD date from a filename. Handles:
 *   - 2025-10-17  /  2025_10_17  /  2025.10.17  /  2025/10/17
 *   - 20251017 (compact, no separators)
 *   - "16 May 2022" / "May 16 2022"  / "16 may 22"
 *
 * Returns null if no date with a year is found. Mirrors the richer
 * extraction logic in migrate-videos-to-bunny.ts so Pass B doesn't lose
 * dates that Pass A would have found.
 */
function extractIsoDate(filename: string): string | null {
  const lower = filename.toLowerCase();

  // YYYY[-_./]MM[-_./]DD
  const isoMatch = lower.match(/(\d{4})[._\-/](\d{1,2})[._\-/](\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]!.padStart(2, "0")}-${isoMatch[3]!.padStart(2, "0")}`;
  }

  // YYYYMMDD compact
  const compactMatch = lower.match(/\b(\d{4})(\d{2})(\d{2})\b/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }

  // "16 May 2022" — day, month-name, year (year is required for full date)
  const monthRe = MONTHS_EN.join("|");
  const dayMonthYear = lower.match(new RegExp(`(\\d{1,2})[ _-]+(${monthRe})[ _-]+(\\d{4})`));
  if (dayMonthYear) {
    const month = String(MONTHS_EN.indexOf(dayMonthYear[2] as any) + 1).padStart(2, "0");
    return `${dayMonthYear[3]}-${month}-${dayMonthYear[1]!.padStart(2, "0")}`;
  }

  // "May 16 2022"
  const monthDayYear = lower.match(new RegExp(`(${monthRe})[ _-]+(\\d{1,2})[ _-]+(\\d{4})`));
  if (monthDayYear) {
    const month = String(MONTHS_EN.indexOf(monthDayYear[1] as any) + 1).padStart(2, "0");
    return `${monthDayYear[3]}-${month}-${monthDayYear[2]!.padStart(2, "0")}`;
  }

  // Abbreviated months: "16 may 22"
  const abbrRe = Object.keys(MONTH_ABBR_EN).join("|");
  const dayAbbrYear = lower.match(new RegExp(`(\\d{1,2})[ _-]+(${abbrRe})\\b[ _-]+(\\d{2,4})`));
  if (dayAbbrYear) {
    const month = String(MONTH_ABBR_EN[dayAbbrYear[2]!]!).padStart(2, "0");
    let year = dayAbbrYear[3]!;
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${dayAbbrYear[1]!.padStart(2, "0")}`;
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

/**
 * Walk events/{code}/video/ for source files (.mp4/.m4a/etc.) whose audio
 * counterpart already exists in events/{code}/audio/ AND has a matching
 * track row pointing at it. The conversion completed in a prior run but
 * the source move didn't — move it to source/ now.
 *
 * This catches:
 *   - State-tracked partial Pass A checkpoints where bunnyDeleted=true but
 *     sourceMoved=false (Bunny listing won't return those GUIDs, so the
 *     main loop can't recover them on its own).
 *   - Pre-checkpoint failures with no state-file entry at all (the original
 *     KPSR 27-May 2022 case where transcode + track + Bunny delete all ran
 *     before the script crashed without ever saving state).
 *
 * Source-of-truth is S3 + DB, not the state file. State is kept in sync
 * when an entry happens to exist.
 */
async function reconcileSourceMoves(args: {
  s3: S3Client;
  bucket: string;
  state: AudioState;
  apply: boolean;
}): Promise<{ moved: number; failed: number }> {
  const { s3, bucket, state, apply } = args;
  const out = { moved: 0, failed: 0 };

  console.log(`\n=== Reconcile: orphaned source files in events/*/video/ ===\n`);

  // List all source files (mp4/m4a/mov/mkv/webm) under events/{code}/video/.
  const sourceKeys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: "events/", ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      if (/^events\/[^/]+\/video\/.+\.(mp4|m4a|mov|mkv|webm)$/i.test(obj.Key)) {
        sourceKeys.push(obj.Key);
      }
    }
    token = res.NextContinuationToken;
  } while (token);

  let candidates = 0;
  for (const sourceKey of sourceKeys) {
    const audioKey = audioKeyFromVideoKey(sourceKey);
    const archivedKey = sourceKeyFromVideoKey(sourceKey);

    // Audio counterpart must exist.
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: audioKey }));
    } catch {
      continue;
    }

    // A track row must point at it.
    const matchingTrack = await db.query.tracks.findFirst({ where: eq(tracks.s3Key, audioKey) });
    if (!matchingTrack) continue;

    candidates++;
    console.log(`  ${sourceKey}`);
    console.log(`    Audio exists at ${audioKey}, track ${matchingTrack.id} references it.`);

    if (!apply) {
      console.log(`    [dry-run] Would move source -> ${archivedKey}`);
      out.moved++;
      continue;
    }

    try {
      await moveS3Object(s3, bucket, sourceKey, archivedKey);
      console.log(`    Moved -> ${archivedKey}`);
      out.moved++;

      // Update state if there's a matching checkpoint. Legacy checkpoints
      // (written before the per-step refactor) may not have a steps field —
      // initialise it so the rest of the script can rely on its shape.
      const cp = state.processed[audioKey];
      if (cp) {
        if (!cp.steps) cp.steps = emptySteps();
        cp.steps.sourceMoved = true;
        if (cp.steps.transcoded && cp.steps.trackInserted) {
          if (cp.pass === "B" || (cp.steps.bunnyDetached && cp.steps.bunnyDeleted)) {
            cp.status = "ok";
            cp.reason = undefined;
          }
        }
        cp.completedAt = new Date().toISOString();
        state.processed[audioKey] = cp;
        saveState(state);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    FAILED: ${msg}`);
      out.failed++;
    }
  }

  if (candidates === 0) console.log(`  No orphaned source files found.`);
  return out;
}

/**
 * Delete Bunny videos that no session in the database references. Resolves
 * orphans created when an upload ran but the DB attach step never landed
 * (e.g. the silent-exit on the first --apply run that left a 1f9d4cb2 GUID
 * stranded in the Bunny library).
 */
async function cleanupOrphanBunny(args: {
  apply: boolean;
}): Promise<{ deleted: number; kept: number; failed: number }> {
  const { apply } = args;
  const out = { deleted: 0, kept: 0, failed: 0 };

  console.log(`\n=== Orphan Bunny videos (no session.bunny_video_id reference) ===\n`);

  const allBunny = await listBunnyVideos();
  for (const v of allBunny) {
    const session = await db.query.sessions.findFirst({
      where: eq(sessions.bunnyVideoId, v.guid),
    });
    if (session) {
      out.kept++;
      continue;
    }
    console.log(`  Orphan: ${v.guid.slice(0, 8)} fps=${v.framerate} len=${v.length}s '${v.title}'`);
    if (!apply) {
      console.log(`    [dry-run] Would delete from Bunny`);
      out.deleted++;
      continue;
    }
    try {
      await deleteVideo(v.guid);
      console.log(`    Deleted from Bunny`);
      out.deleted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    FAILED to delete: ${msg}`);
      out.failed++;
    }
  }
  return out;
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
  console.log(`\nFound ${fakeVideos.length} Bunny videos at <= ${FAKE_VIDEO_FRAMERATE_THRESHOLD} fps (${allBunny.length} total)\n`);

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

    // 4. Load or initialise the checkpoint for this conversion.
    const cp: ConversionCheckpoint = state.processed[audioKey] ?? {
      sourceS3Key: sourceKey,
      audioS3Key: audioKey,
      archivedS3Key: archivedKey,
      eventCode: event.eventCode,
      sessionId: session.id,
      trackId: null,
      bunnyVideoId: v.guid,
      pass: "A",
      status: "partial",
      steps: emptySteps(),
      completedAt: new Date().toISOString(),
    };

    if (cp.status === "ok") {
      console.log(`    Already converted on ${cp.completedAt} — skipping`);
      out.skipped++;
      continue;
    }

    if (!apply) {
      const remaining = [
        !cp.steps.transcoded ? "transcode" : null,
        !cp.steps.trackInserted ? "create track" : null,
        !cp.steps.bunnyDetached ? "detach Bunny" : null,
        !cp.steps.bunnyDeleted ? "delete Bunny" : null,
        !cp.steps.sourceMoved ? "move source" : null,
      ].filter(Boolean).join(", ");
      console.log(`    [dry-run] Remaining steps: ${remaining}`);
      console.log(`              session ${session.id} '${event.eventCode}', GUID ${v.guid}`);
      out.ok++;
      continue;
    }

    try {
      const filename = sourceKey.split("/").pop() ?? "track.mp4";

      // 5. Transcode (skip if already done).
      if (!cp.steps.transcoded) {
        console.log(`    Transcoding to ${audioKey} ...`);
        await transcodeS3ToS3({ s3, bucket, sourceKey, destKey: audioKey });
        cp.steps.transcoded = true;
        state.processed[audioKey] = cp;
        saveState(state);
      }
      const audioSize = await getS3ObjectSize(s3, bucket, audioKey);
      console.log(`    Audio: ${(audioSize / 1024 / 1024).toFixed(1)} MB`);

      // 6. Insert track row (skip if already done).
      if (!cp.steps.trackInserted || !cp.trackId) {
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
        cp.trackId = track.id;
        cp.steps.trackInserted = true;
        state.processed[audioKey] = cp;
        saveState(state);
        console.log(`    Inserted track ${track.id} #${trackNumber} on session ${session.id}`);
      }

      // 7. NULL out the session's bunny_video_id (skip if already done).
      if (!cp.steps.bunnyDetached) {
        await db.update(sessions)
          .set({
            bunnyVideoId: null,
            videoDurationSeconds: null,
            videoPosterUrl: null,
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, session.id));
        cp.steps.bunnyDetached = true;
        state.processed[audioKey] = cp;
        saveState(state);
      }

      // 8. Delete the Bunny video (skip if already done).
      if (!cp.steps.bunnyDeleted) {
        await deleteVideo(v.guid);
        cp.steps.bunnyDeleted = true;
        state.processed[audioKey] = cp;
        saveState(state);
        console.log(`    Deleted Bunny video ${v.guid}`);
      }

      // 9. Move source MP4 to source/ (skip if already done).
      if (!cp.steps.sourceMoved) {
        await moveS3Object(s3, bucket, sourceKey, archivedKey);
        cp.steps.sourceMoved = true;
        state.processed[audioKey] = cp;
        saveState(state);
        console.log(`    Moved ${sourceKey} -> ${archivedKey}`);
      }

      cp.status = "ok";
      cp.completedAt = new Date().toISOString();
      state.processed[audioKey] = cp;
      saveState(state);
      out.ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    FAILED at first incomplete step: ${msg}`);
      cp.status = "error";
      cp.reason = msg;
      cp.completedAt = new Date().toISOString();
      state.processed[audioKey] = cp;
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

    const event = await db.query.events.findFirst({ where: eq(events.eventCode, eventCode) });
    if (!event) {
      console.log(`    Event "${eventCode}" not found — skipping`);
      out.skipped++;
      continue;
    }

    // Load or initialise the checkpoint.
    const cp: ConversionCheckpoint = state.processed[audioKey] ?? {
      sourceS3Key: key,
      audioS3Key: audioKey,
      archivedS3Key: archivedKey,
      eventCode,
      sessionId: null,
      trackId: null,
      bunnyVideoId: null,
      pass: "B",
      status: "partial",
      steps: emptySteps(),
      completedAt: new Date().toISOString(),
    };

    if (cp.status === "ok") {
      console.log(`    Already converted on ${cp.completedAt} — skipping`);
      out.skipped++;
      continue;
    }

    // Pick or create a session for this file. Prefer the checkpoint's
    // session if one was already chosen on a prior run; otherwise match by
    // date in the filename, otherwise auto-create.
    const fileDate = extractIsoDate(filename);
    let targetSessionId: number | null = cp.sessionId;
    let createdSession = false;

    if (!targetSessionId && fileDate) {
      const found = await db.query.sessions.findFirst({
        where: and(eq(sessions.eventId, event.id), eq(sessions.sessionDate, fileDate)),
      });
      if (found) targetSessionId = found.id;
    }

    if (!targetSessionId) {
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
        targetSessionId = created.id;
        cp.sessionId = created.id;
        createdSession = true;
        console.log(`    Auto-created session ${created.id} #${sn}`);
      }
    } else if (!cp.sessionId) {
      cp.sessionId = targetSessionId;
      console.log(`    Matched existing session ${targetSessionId}${fileDate ? ` by date ${fileDate}` : ""}`);
    } else {
      console.log(`    Resuming on session ${targetSessionId}`);
    }

    if (!apply) {
      const remaining = [
        !cp.steps.transcoded ? "transcode" : null,
        !cp.steps.trackInserted ? "create track" : null,
        !cp.steps.sourceMoved ? "move source" : null,
      ].filter(Boolean).join(", ");
      console.log(`    [dry-run] Remaining steps: ${remaining || "none"}`);
      out.ok++;
      continue;
    }

    try {
      // Transcode (skip if already done).
      if (!cp.steps.transcoded) {
        console.log(`    Transcoding to ${audioKey} ...`);
        await transcodeS3ToS3({ s3, bucket, sourceKey: key, destKey: audioKey });
        cp.steps.transcoded = true;
        state.processed[audioKey] = cp;
        saveState(state);
      }
      const audioSize = await getS3ObjectSize(s3, bucket, audioKey);
      console.log(`    Audio: ${(audioSize / 1024 / 1024).toFixed(1)} MB`);

      // Insert track row (skip if already done).
      if (!cp.steps.trackInserted || !cp.trackId) {
        const title = deriveTitle(filename);
        const trackNumber = await nextTrackNumber(targetSessionId!);
        const speaker = inferSpeaker(filename);
        const [track] = await db.insert(tracks).values({
          sessionId: targetSessionId!,
          title,
          trackNumber,
          languages: ["en"],
          originalLanguage: "en",
          isTranslation: false,
          s3Key: audioKey,
          durationSeconds: 0, // probed/backfilled later
          fileSizeBytes: audioSize,
          originalFilename: filename,
          speaker,
          fileFormat: "mp3",
        }).returning();
        if (!track) throw new Error("Failed to insert track row");
        cp.trackId = track.id;
        cp.steps.trackInserted = true;
        state.processed[audioKey] = cp;
        saveState(state);
        console.log(`    Inserted track ${track.id} #${trackNumber} on session ${targetSessionId}${createdSession ? " (newly created)" : ""}`);
      }

      // Move source m4a (skip if already done).
      if (!cp.steps.sourceMoved) {
        await moveS3Object(s3, bucket, key, archivedKey);
        cp.steps.sourceMoved = true;
        state.processed[audioKey] = cp;
        saveState(state);
        console.log(`    Moved ${key} -> ${archivedKey}`);
      }

      cp.status = "ok";
      cp.reason = undefined;
      cp.completedAt = new Date().toISOString();
      state.processed[audioKey] = cp;
      saveState(state);
      out.ok++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`    FAILED at first incomplete step: ${msg}`);
      cp.status = "error";
      cp.reason = msg;
      cp.completedAt = new Date().toISOString();
      state.processed[audioKey] = cp;
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

  const reconcile = await reconcileSourceMoves({ s3, bucket, state, apply });
  const passA = await passA_fakeVideos({ s3, bucket, state, apply });
  const passB = await passB_strayM4a({ s3, bucket, state, apply });
  const orphans = await cleanupOrphanBunny({ apply });

  console.log(`\n=== Summary ===`);
  console.log(`  Reconcile (orphan source moves): moved=${reconcile.moved}  failed=${reconcile.failed}`);
  console.log(`  Pass A (Bunny audio-as-video):   ok=${passA.ok}  skipped=${passA.skipped}  failed=${passA.failed}`);
  console.log(`  Pass B (stray .m4a):             ok=${passB.ok}  skipped=${passB.skipped}  failed=${passB.failed}`);
  console.log(`  Orphan Bunny videos:             deleted=${orphans.deleted}  kept=${orphans.kept}  failed=${orphans.failed}`);
  console.log(`  State file: ${STATE_FILE}`);
  if (!apply) console.log(`\n(dry run — pass --apply to actually do the work)`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
