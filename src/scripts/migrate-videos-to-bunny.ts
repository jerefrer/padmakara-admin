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
  /**
   * Content-fingerprint -> Bunny GUID. Lets us reuse one Bunny upload across
   * multiple S3 keys (and therefore multiple sessions) when the file content
   * is byte-identical. Fingerprint format: `${size}-${etag}`.
   */
  byFingerprint?: Record<string, string>;
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

const MONTHS_EN = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
] as const;

const MONTH_ABBR_EN: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Extract every plausible YYYY-MM-DD date from a filename. Handles:
 *   - 2025-10-17  /  2025_10_17  /  2025.10.17  /  2025/10/17
 *   - 20251017 (compact, no separators)
 *   - "16 May 2022" / "16 May" / "May 16 2022"
 *
 * Returns ISO strings in the order they appear.
 */
function extractDates(filename: string): string[] {
  const lower = filename.toLowerCase();
  const out: string[] = [];

  // YYYY[-_./]MM[-_./]DD
  for (const m of lower.matchAll(/(\d{4})[._\-/](\d{1,2})[._\-/](\d{1,2})/g)) {
    out.push(`${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`);
  }

  // YYYYMMDD compact
  for (const m of lower.matchAll(/\b(\d{4})(\d{2})(\d{2})\b/g)) {
    out.push(`${m[1]}-${m[2]}-${m[3]}`);
  }

  // "16 May 2022" / "May 16 2022" with optional year
  const monthRe = MONTHS_EN.join("|");
  const reA = new RegExp(`(\\d{1,2})[ _-]+(${monthRe})(?:[ _-]+(\\d{4}))?`, "g");
  const reB = new RegExp(`(${monthRe})[ _-]+(\\d{1,2})(?:[ _-]+(\\d{4}))?`, "g");
  for (const m of lower.matchAll(reA)) {
    const day = m[1]!.padStart(2, "0");
    const month = String(MONTHS_EN.indexOf(m[2] as any) + 1).padStart(2, "0");
    if (m[3]) out.push(`${m[3]}-${month}-${day}`);
    else out.push(`????-${month}-${day}`);
  }
  for (const m of lower.matchAll(reB)) {
    const month = String(MONTHS_EN.indexOf(m[1] as any) + 1).padStart(2, "0");
    const day = m[2]!.padStart(2, "0");
    if (m[3]) out.push(`${m[3]}-${month}-${day}`);
    else out.push(`????-${month}-${day}`);
  }

  // Abbreviated months: "16 may", "16-may-22"
  const abbrRe = Object.keys(MONTH_ABBR_EN).join("|");
  const reC = new RegExp(`(\\d{1,2})[ _-]+(${abbrRe})\\b(?:[ _-]+(\\d{2,4}))?`, "g");
  for (const m of lower.matchAll(reC)) {
    const day = m[1]!.padStart(2, "0");
    const month = String(MONTH_ABBR_EN[m[2]!]!).padStart(2, "0");
    let year = m[3];
    if (year && year.length === 2) year = `20${year}`;
    if (year) out.push(`${year}-${month}-${day}`);
    else out.push(`????-${month}-${day}`);
  }

  return Array.from(new Set(out));
}

/**
 * Tokenize for fuzzy substring matching. Lowercase, replaces non-alphanumerics
 * with spaces, collapses whitespace.
 */
function tokenize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/**
 * Strip extension and known media-marker suffixes from a filename to derive
 * a clean session title. Examples:
 *   "John Canti - Gyu Lama - 17 May 2022 [AUDIO].mp4"
 *     → "John Canti - Gyu Lama - 17 May 2022"
 *   "2025-10-17-Mind_Trainning_1 [ENG - Video].mp4"
 *     → "Mind Trainning 1 — 2025-10-17"   (date moved to the end if it leads)
 */
function deriveSessionTitle(filename: string): string {
  let title = filename.replace(/\.[^.]+$/, ""); // strip extension
  // Strip bracketed metadata: [ENG], [POR], [Audio], [Video], [ENG - Audio], etc.
  title = title.replace(/\[[^\]]*\]/g, "").trim();
  // Strip trailing markers like "- Video", "- Audio", "- EN", "- POR"
  title = title.replace(/[-_\s]+(?:video|audio|eng?|por|fra|tib|fr|en|pt)\b/gi, "").trim();
  // Collapse separators
  title = title.replace(/[_]+/g, " ").replace(/\s+/g, " ").replace(/^[-\s]+|[-\s]+$/g, "");
  return title || filename.replace(/\.[^.]+$/, "");
}

/**
 * Pick the best session for a given filename within an event.
 * Returns the session id, or null if it can't decide unambiguously.
 *
 * `autoCreate=true` creates a brand-new session for the file when the event
 * has zero sessions yet. The session inherits the date from the filename
 * (when extractable) and a title derived from the filename. Used for events
 * that landed in the DB without sessions because they were added to S3
 * after the original Wix CSV export.
 */
async function pickSession(
  eventId: number,
  filename: string,
  opts: { autoCreate: boolean; apply: boolean } = { autoCreate: false, apply: false },
): Promise<{
  sessionId: number | null;
  reason: string;
  created?: boolean;
}> {
  const eventSessions = await db.query.sessions.findMany({
    where: eq(sessions.eventId, eventId),
  });

  if (eventSessions.length === 0) {
    if (!opts.autoCreate) {
      return { sessionId: null, reason: "no sessions exist for this event" };
    }
    // Create a new session for this video.
    const fileDates = extractDates(filename).filter((d) => !d.startsWith("????"));
    const sessionDate = fileDates[0] ?? null;
    const titleEn = deriveSessionTitle(filename);
    if (!opts.apply) {
      return {
        sessionId: null,
        reason: `[would auto-create session #1: date=${sessionDate ?? "n/a"}, title="${titleEn}"]`,
        created: true,
      };
    }
    const [created] = await db.insert(sessions).values({
      eventId,
      titleEn,
      sessionDate,
      sessionNumber: 1,
      timePeriod: null,
    }).returning();
    if (!created) return { sessionId: null, reason: "failed to create session" };
    return {
      sessionId: created.id,
      reason: `auto-created session #1 (date=${sessionDate ?? "n/a"}, title="${titleEn}")`,
      created: true,
    };
  }
  if (eventSessions.length === 1) {
    // If autoCreate is on AND the existing session already has a video
    // attached, create a sibling session for THIS video instead of refusing.
    if (opts.autoCreate && eventSessions[0]!.bunnyVideoId) {
      const fileDates = extractDates(filename).filter((d) => !d.startsWith("????"));
      const sessionDate = fileDates[0] ?? null;
      const titleEn = deriveSessionTitle(filename);
      const nextNum = (eventSessions[0]!.sessionNumber || 0) + 1;
      if (!opts.apply) {
        return {
          sessionId: null,
          reason: `[would auto-create sibling session #${nextNum}: date=${sessionDate ?? "n/a"}, title="${titleEn}"]`,
          created: true,
        };
      }
      const [created] = await db.insert(sessions).values({
        eventId,
        titleEn,
        sessionDate,
        sessionNumber: nextNum,
        timePeriod: null,
      }).returning();
      if (created) {
        return {
          sessionId: created.id,
          reason: `auto-created session #${nextNum} (existing session has different video)`,
          created: true,
        };
      }
    }
    return { sessionId: eventSessions[0]!.id, reason: "only one session in event" };
  }

  const fileLower = filename.toLowerCase();
  const fileTokens = tokenize(filename);

  // 1. "Day N" → sessionNumber
  const dayMatch = fileLower.match(/day[ _-]?(\d+)/);
  if (dayMatch) {
    const n = parseInt(dayMatch[1]!, 10);
    const candidates = eventSessions.filter((s) => s.sessionNumber === n);
    if (candidates.length === 1) return { sessionId: candidates[0]!.id, reason: `matched Day ${n}` };
  }

  // 2. Date matching (any of: ISO, compact, "16 May 2022")
  const fileDates = extractDates(filename);
  for (const target of fileDates) {
    if (target.startsWith("????")) continue;
    const candidates = eventSessions.filter((s) => s.sessionDate === target);
    if (candidates.length === 1) return { sessionId: candidates[0]!.id, reason: `matched date ${target}` };
    if (candidates.length > 1) {
      // Multiple sessions on the same date — try to disambiguate by teacher
      // abbreviation appearing in the filename (e.g. "JKR", "KPSR", "PWR").
      const tokens = fileTokens;
      const abbrev = candidates.find((s) => {
        const title = tokenize(s.titleEn ?? "");
        const firstWord = title.split(" ")[0];
        return firstWord && firstWord.length >= 2 && tokens.includes(firstWord);
      });
      if (abbrev) return { sessionId: abbrev.id, reason: `matched date ${target} + teacher tag` };
    }
  }

  // 3. Title substring — both directions:
  //    a) filename includes session title  (filename "Bodhicitta teaching.mp4", title "Bodhicitta")
  //    b) session title includes the filename core  (filename "Refuge.mp4", title "Refuge — Day 1")
  for (const s of eventSessions) {
    const titleLower = (s.titleEn ?? "").toLowerCase().trim();
    if (!titleLower) continue;
    if (fileLower.includes(titleLower) || titleLower.includes(fileLower.replace(/\.[^.]+$/, ""))) {
      return { sessionId: s.id, reason: `title substring "${titleLower}"` };
    }
  }

  // 4. Token-based intersection: session whose title shares the most distinctive
  //    tokens with the filename, requiring at least 2 distinctive shared tokens.
  const STOPWORDS = new Set([
    "the", "of", "and", "on", "a", "an", "in", "to", "for", "video", "audio",
    "eng", "por", "tib", "fra", "fr", "en", "pt", "mp3", "mp4", "with", "session",
    "part", "day", "morning", "afternoon", "evening",
  ]);
  const fileTokenSet = new Set(
    fileTokens.split(" ").filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
  );

  let bestSession: { id: number; matchedTokens: string[] } | null = null;
  for (const s of eventSessions) {
    const titleTokens = tokenize(s.titleEn ?? "").split(" ");
    const matched = titleTokens.filter((t) => fileTokenSet.has(t) && t.length >= 3 && !STOPWORDS.has(t));
    if (matched.length >= 2 && (!bestSession || matched.length > bestSession.matchedTokens.length)) {
      bestSession = { id: s.id, matchedTokens: matched };
    }
  }
  if (bestSession) {
    return {
      sessionId: bestSession.id,
      reason: `token match: [${bestSession.matchedTokens.join(", ")}]`,
    };
  }

  return {
    sessionId: null,
    reason: `ambiguous — ${eventSessions.length} sessions, no keyword/date/title/token match`,
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
  const allKeys: { key: string; size: number; etag: string }[] = [];
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
        // S3 ETag is wrapped in quotes; strip them. For non-multipart uploads
        // it's the MD5 of the object — a perfectly good content fingerprint.
        // For multipart it's still deterministic per-object so byte-identical
        // uploads of the same file via the same multipart settings collide.
        const etag = (obj.ETag ?? "").replace(/^"|"$/g, "");
        allKeys.push({ key: obj.Key, size: obj.Size, etag });
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
  const manualActions = {
    /** Event exists in code path but is missing from the DB entirely. */
    missingEvents: new Set<string>(),
    /** Event has multiple sessions and the matcher couldn't pick one. */
    ambiguous: [] as { key: string; eventCode: string; reason: string }[],
    /** Anything else that needed to be skipped. */
    otherSkipped: [] as { key: string; eventCode: string; reason: string }[],
  };

  // Fingerprint -> GUID cache, populated as we go and persisted to state.
  state.byFingerprint = state.byFingerprint ?? {};

  for (const { key, size, etag } of allKeys) {
    const parsed = parseS3Key(key)!;
    const fingerprint = `${size}-${etag}`;
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
      console.log(`  No event with eventCode "${parsed.eventCode}" — needs manual creation in admin`);
      manualActions.missingEvents.add(parsed.eventCode);
      state.processed[key] = {
        s3Key: key, eventCode: parsed.eventCode, sessionId: null, bunnyVideoId: null,
        status: "skipped", reason: "event not found", completedAt: new Date().toISOString(),
      };
      saveState(state);
      skipped++;
      continue;
    }

    // 3. Pick or auto-create a session.
    //    - Empty event (no sessions yet): create one named after the file.
    //    - Single session already used by a different video: create a sibling.
    //    - Multi-session event with no match: still skip and surface for review.
    const result = await pickSession(event.id, parsed.filename, {
      autoCreate: true,
      apply,
    });
    const sessionId: number | null = result.sessionId;
    const reason = result.reason;

    if (!sessionId) {
      // In dry-run, an auto-create reason still ends up here (sessionId is
      // null because we didn't actually insert). Treat it as "would succeed"
      // for the dry-run summary, not as a manual action.
      if (!apply && result.created) {
        console.log(`  ${reason}`);
        console.log(`  [dry-run] Would upload to Bunny and attach to the new session`);
        continue;
      }
      console.log(`  Cannot pick session: ${reason} — skipping (resolve manually then re-run)`);
      manualActions.ambiguous.push({ key, eventCode: parsed.eventCode, reason });
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

    // 5a. Content-dedup short-circuit: if we've already uploaded a file with
    //     this exact fingerprint (size + S3 ETag), reuse the same Bunny GUID
    //     and just point this session at it. Sessions sharing a GUID are
    //     handled correctly by the ref-counted DELETE in admin/sessions.ts.
    const existingGuid = state.byFingerprint[fingerprint];
    if (existingGuid) {
      console.log(`  Content matches an already-uploaded file (fingerprint ${fingerprint.slice(0, 32)}...)`);
      console.log(`  Reusing Bunny ${existingGuid} -> session ${sessionId} (no new upload)`);
      if (!apply) {
        console.log(`  [dry-run] Would attach existing GUID to session ${sessionId}`);
        continue;
      }
      try {
        // Pull duration from Bunny in case the original upload didn't capture it.
        const meta = await getVideoMeta(existingGuid).catch(() => null);
        const duration = meta ? Math.round(meta.length || 0) : null;
        await db.update(sessions)
          .set({ bunnyVideoId: existingGuid, videoDurationSeconds: duration, updatedAt: new Date() })
          .where(eq(sessions.id, sessionId));
        state.processed[key] = {
          s3Key: key, eventCode: parsed.eventCode, sessionId, bunnyVideoId: existingGuid,
          status: "ok", reason: "deduplicated by content fingerprint",
          completedAt: new Date().toISOString(),
        };
        saveState(state);
        succeeded++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  FAILED to reuse GUID: ${msg}`);
        state.processed[key] = {
          s3Key: key, eventCode: parsed.eventCode, sessionId, bunnyVideoId: null,
          status: "error", reason: msg, completedAt: new Date().toISOString(),
        };
        saveState(state);
        failed++;
      }
      continue;
    }

    if (!apply) {
      console.log(`  [dry-run] Would upload to Bunny and set sessions.bunnyVideoId on session ${sessionId}`);
      continue;
    }

    // 5b. New content — full upload.
    try {
      const { guid, durationSeconds } = await uploadFromS3ToBunny({
        s3, bucket, key, filename: parsed.filename, fileSize: size,
      });

      // 6. Patch the session row.
      await db.update(sessions)
        .set({ bunnyVideoId: guid, videoDurationSeconds: durationSeconds || null, updatedAt: new Date() })
        .where(eq(sessions.id, sessionId));

      // Cache the fingerprint -> GUID so any later S3 keys with identical
      // content reuse this upload instead of duplicating.
      state.byFingerprint[fingerprint] = guid;

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
  if (!apply) console.log(`(dry run — pass --apply to actually migrate)`);

  // Clear, actionable list of what still needs human attention.
  const hasManual =
    manualActions.missingEvents.size > 0 ||
    manualActions.ambiguous.length > 0 ||
    manualActions.otherSkipped.length > 0;

  if (hasManual) {
    console.log(`\n=== Manual actions needed ===`);

    if (manualActions.missingEvents.size > 0) {
      console.log(`\n${manualActions.missingEvents.size} event(s) referenced by S3 do NOT exist in the DB.`);
      console.log(`These must be created in the admin UI (set audience, retreat group, titles, etc.).`);
      console.log(`After creating them, just re-run this script — the rest is automatic.\n`);
      const sorted = Array.from(manualActions.missingEvents).sort();
      for (const code of sorted) {
        // How many video files would attach once the event exists?
        const fileCount = allKeys.filter((k) => parseS3Key(k.key)?.eventCode === code).length;
        console.log(`  - ${code}  (${fileCount} video file${fileCount === 1 ? "" : "s"} waiting)`);
      }
    }

    if (manualActions.ambiguous.length > 0) {
      console.log(`\n${manualActions.ambiguous.length} file(s) couldn't be matched to a specific session in a multi-session event.`);
      console.log(`Either: (a) rename/edit a session's titleEn or sessionDate so the matcher picks it up,`);
      console.log(`        (b) create a new session in the admin UI for this video, OR`);
      console.log(`        (c) attach manually via the admin (SQL: UPDATE sessions SET bunny_video_id = ... WHERE id = ...).`);
      console.log(`Re-running the script after option (a) or (b) will pick these up automatically.\n`);
      for (const m of manualActions.ambiguous) {
        console.log(`  - ${m.eventCode} :: ${parseS3Key(m.key)?.filename}`);
        console.log(`      reason: ${m.reason}`);
      }
    }

    if (manualActions.otherSkipped.length > 0) {
      console.log(`\nOther skipped:`);
      for (const m of manualActions.otherSkipped) {
        console.log(`  - ${m.key}  →  ${m.reason}`);
      }
    }
  } else {
    console.log(`\nNothing left to do manually. Run with --apply to migrate everything.`);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
