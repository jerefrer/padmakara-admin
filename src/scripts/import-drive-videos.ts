/**
 * Import Google Drive videos into Bunny Stream + session_videos.
 *
 * Usage:
 *   bun src/scripts/import-drive-videos.ts --event <eventId> --folder <driveFolderId> [--dry-run]
 *
 * Env:
 *   GDRIVE_API_KEY   Drive API key. The Drive folder must be shared
 *                    "anyone with link — viewer".
 *   Bunny creds come from config.bunny (BUNNY_STREAM_LIBRARY_ID / BUNNY_STREAM_API_KEY).
 *   DATABASE_URL     Postgres connection (via config.database.url).
 *
 * Behavior:
 *   1. Lists files directly inside the Drive folder, keeping only video
 *      files (.mpg/.mp4/.mov, case-insensitive).
 *   2. Parses the leading YYYYMMDDHHMMSS timestamp from each filename to
 *      get a date + time (e.g. "20090621161350.mpg" → 2009-06-21 16:13:50).
 *      Files with no parseable leading timestamp are skipped with a warning.
 *   3. Assigns an ascending `position` (0,1,2…) to files sharing the same
 *      date, ordered by time.
 *   4. Matches each date to a `sessions` row of the target event
 *      (sessionDate = date). Files with no matching session are skipped
 *      with a warning.
 *   5. Pulls each remaining file into Bunny Stream via fetchVideo(), using
 *      a direct-download URL:
 *        https://www.googleapis.com/drive/v3/files/{fileId}?alt=media&key={KEY}
 *      Bunny's fetch response doesn't always include the created video's
 *      guid — if it's missing, falls back to searching the Bunny library's
 *      video list by title to recover it.
 *   6. Inserts a session_videos row:
 *        { sessionId, bunnyVideoId: guid, position, title }
 *      title is "Part N" when the session's date has more than one file,
 *      otherwise null.
 *
 *   --dry-run prints the planned file → session → position mapping and
 *   exits without calling Bunny or writing to the database.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { events } from "../db/schema/retreats.ts";
import { sessions } from "../db/schema/sessions.ts";
import { sessionVideos } from "../db/schema/session-videos.ts";
import { fetchVideo } from "../services/bunny.ts";
import { config } from "../config.ts";

const VIDEO_EXTENSION_RE = /\.(mpg|mp4|mov)$/i;
const LEADING_TIMESTAMP_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/;

export interface DriveFile {
  id: string;
  name: string;
  size?: string;
}

export interface ParsedDriveVideoName {
  date: string;
  time: string;
}

export interface PositionedDriveFile extends DriveFile, ParsedDriveVideoName {
  position: number;
}

/**
 * Parse the leading YYYYMMDDHHMMSS timestamp from a Drive filename.
 * Returns null if the name doesn't start with a 14-digit timestamp.
 *
 * "20090621161350.mpg" → { date: "2009-06-21", time: "16:13:50" }
 */
export function parseDriveVideoName(name: string): ParsedDriveVideoName | null {
  const match = LEADING_TIMESTAMP_RE.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
  };
}

/**
 * Parse + sort files by date+time and assign a 0-based `position` within
 * each date, resetting to 0 whenever the date changes. Files whose name has
 * no leading timestamp are dropped from the result — callers that need to
 * warn about skipped files should check with parseDriveVideoName first.
 */
export function assignPositions(files: DriveFile[]): PositionedDriveFile[] {
  const parsed: (DriveFile & ParsedDriveVideoName)[] = [];
  for (const file of files) {
    const stamp = parseDriveVideoName(file.name);
    if (stamp) parsed.push({ ...file, ...stamp });
  }

  parsed.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const nextPositionByDate = new Map<string, number>();
  return parsed.map((file) => {
    const position = nextPositionByDate.get(file.date) ?? 0;
    nextPositionByDate.set(file.date, position + 1);
    return { ...file, position };
  });
}

function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSION_RE.test(name);
}

function buildDriveMediaUrl(fileId: string, apiKey: string): string {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
}

async function listDriveFolder(folderId: string, apiKey: string): Promise<DriveFile[]> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", `'${folderId}' in parents and trashed = false`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("fields", "files(id,name,size)");
  url.searchParams.set("pageSize", "1000");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Drive API ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as { files?: DriveFile[] };
  return data.files ?? [];
}

/**
 * Recover a video's Bunny guid by searching the library's video list by
 * exact title match. Used when fetchVideo()'s response body has no guid.
 */
async function findVideoGuidByTitle(title: string): Promise<string | null> {
  if (!config.bunny.libraryId || !config.bunny.apiKey) {
    throw new Error("Bunny Stream API credentials are not configured");
  }
  const url = `https://video.bunnycdn.com/library/${config.bunny.libraryId}/videos?search=${encodeURIComponent(title)}`;
  const response = await fetch(url, {
    headers: { AccessKey: config.bunny.apiKey, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Bunny API ${response.status}: ${await response.text()}`);
  }
  const data = (await response.json()) as { items?: { guid: string; title: string }[] };
  const match = (data.items ?? []).find((item) => item.title === title);
  return match?.guid ?? null;
}

/**
 * Pull a video into Bunny Stream, recovering the guid via library search if
 * the fetch response body didn't include one.
 */
async function pullVideoToBunny(sourceUrl: string, title: string): Promise<string> {
  try {
    const { guid } = await fetchVideo(sourceUrl, title);
    return guid;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("no guid")) throw err;
    console.warn(`  fetchVideo returned no guid for "${title}"; searching library by title…`);
    const guid = await findVideoGuidByTitle(title);
    if (!guid) throw new Error(`Could not recover Bunny guid for "${title}" after fetch`);
    return guid;
  }
}

interface CliArgs {
  eventId: number;
  folderId: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let eventId: number | null = null;
  let folderId: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--event") eventId = Number(argv[++i]);
    else if (arg === "--folder") folderId = argv[++i] ?? null;
    else if (arg === "--dry-run") dryRun = true;
  }
  if (!eventId || Number.isNaN(eventId) || !folderId) {
    throw new Error(
      "Usage: bun src/scripts/import-drive-videos.ts --event <eventId> --folder <driveFolderId> [--dry-run]",
    );
  }
  return { eventId, folderId, dryRun };
}

async function main(): Promise<void> {
  const { eventId, folderId, dryRun } = parseArgs(process.argv.slice(2));

  const apiKey = process.env.GDRIVE_API_KEY;
  if (!apiKey) throw new Error("Missing required environment variable: GDRIVE_API_KEY");

  const event = await db.query.events.findFirst({ where: eq(events.id, eventId) });
  if (!event) throw new Error(`Event ${eventId} not found`);

  console.log(`Listing Drive folder ${folderId}…`);
  const allFiles = await listDriveFolder(folderId, apiKey);
  const videoFiles = allFiles.filter((f) => isVideoFile(f.name));
  console.log(`Found ${videoFiles.length} video file(s) of ${allFiles.length} total.`);

  for (const file of videoFiles) {
    if (!parseDriveVideoName(file.name)) {
      console.warn(`  SKIP (no leading YYYYMMDDHHMMSS timestamp): ${file.name}`);
    }
  }

  const positioned = assignPositions(videoFiles);

  const filesPerDate = new Map<string, number>();
  for (const file of positioned) {
    filesPerDate.set(file.date, (filesPerDate.get(file.date) ?? 0) + 1);
  }

  const eventSessions = await db.query.sessions.findMany({ where: eq(sessions.eventId, eventId) });
  const sessionByDate = new Map(
    eventSessions.filter((s) => s.sessionDate).map((s) => [s.sessionDate as string, s]),
  );

  const plan: { file: PositionedDriveFile; session: (typeof eventSessions)[number] }[] = [];
  for (const file of positioned) {
    const session = sessionByDate.get(file.date);
    if (!session) {
      console.warn(`  SKIP (no session dated ${file.date} in event ${eventId}): ${file.name}`);
      continue;
    }
    plan.push({ file, session });
  }

  console.log(`\nPlan (${plan.length} file(s) to import):`);
  for (const { file, session } of plan) {
    const title = filesPerDate.get(file.date)! > 1 ? `Part ${file.position + 1}` : null;
    console.log(
      `  ${file.name} → date=${file.date} sessionId=${session.id} position=${file.position} title=${title ?? "(none)"}`,
    );
  }

  if (dryRun) {
    console.log("\n--dry-run: no changes made.");
    return;
  }

  let created = 0;
  for (const { file, session } of plan) {
    const sourceUrl = buildDriveMediaUrl(file.id, apiKey);
    const fetchTitle = `${event.eventCode} ${file.date} part ${file.position + 1}`;
    console.log(`\nPulling "${file.name}" into Bunny as "${fetchTitle}"…`);
    const guid = await pullVideoToBunny(sourceUrl, fetchTitle);

    const videoTitle = filesPerDate.get(file.date)! > 1 ? `Part ${file.position + 1}` : null;
    await db.insert(sessionVideos).values({
      sessionId: session.id,
      bunnyVideoId: guid,
      position: file.position,
      title: videoTitle,
    });
    console.log(`  OK: guid=${guid} → session_videos row (sessionId=${session.id}, position=${file.position})`);
    created++;
  }

  console.log(`\nDone: ${created} video(s) imported.`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
