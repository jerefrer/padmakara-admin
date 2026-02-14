/**
 * Sync DB s3Key values using the migration inventory JSON as source of truth.
 *
 * The inventory (s3-inventory.json) contains the exact file contents of every
 * zip archive and loose file, along with the canonical event code and category.
 * Combined with the CATEGORY_MAP from s3_migrate.py, we can reconstruct the
 * exact target s3Key for every audio file after migration.
 *
 * Usage:
 *   bun run src/scripts/sync-s3-keys.ts              # fix all
 *   bun run src/scripts/sync-s3-keys.ts --dry-run    # inspect only
 */

import { readFileSync } from "fs";
import { basename, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { sessions } from "../db/schema/sessions.ts";
import { events } from "../db/schema/retreats.ts";
import { eq } from "drizzle-orm";

const isDryRun = process.argv.includes("--dry-run");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INVENTORY_PATH = resolve(
  __dirname,
  "../../../scripts/migration/s3-inventory.json",
);

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".wav",
  ".flac",
  ".ogg",
  ".aac",
]);

// Mirrors CATEGORY_MAP from s3_migrate.py
const CATEGORY_SUBFOLDER: Record<string, string> = {
  audio1: "audio",
  audio2: "audio",
};

interface InventoryFile {
  relativePath: string;
  category: string;
  zipContents?: { name: string; uncompressedSize: number; type: string }[];
}

interface InventoryEvent {
  canonicalCode: string;
  files: InventoryFile[];
  migrationPlan?: {
    actions: {
      action: string;
      source: string;
      category: string;
    }[];
    duplicateGroups?: {
      filename: string;
      occurrences: { source: string; category: string }[];
    }[];
  };
}

/**
 * Build a map of target s3Key → uncompressedSize for a single event
 * from its inventory data, replicating the logic in s3_migrate.py.
 */
function buildTargetKeys(
  evt: InventoryEvent,
): Map<string, number> {
  const code = evt.canonicalCode;
  const result = new Map<string, number>();
  const plan = evt.migrationPlan;
  if (!plan) return result;

  // Build skip set from duplicate analysis (same as s3_migrate.py analyze_duplicates)
  const skipFiles = new Map<string, Set<string>>(); // zip source → basenames to skip
  for (const group of plan.duplicateGroups ?? []) {
    const byCategory = new Map<string, typeof group.occurrences>();
    for (const occ of group.occurrences) {
      const list = byCategory.get(occ.category) || [];
      list.push(occ);
      byCategory.set(occ.category, list);
    }
    // If same size across categories → skip from audio2
    const audio2Occs = byCategory.get("audio2") || [];
    for (const occ of audio2Occs) {
      const existing = skipFiles.get(occ.source) || new Set();
      existing.add(basename(occ.fullPath));
      skipFiles.set(occ.source, existing);
    }
  }

  for (const action of plan.actions) {
    const cat = action.category;
    if (cat !== "audio1" && cat !== "audio2") continue;
    const subfolder = CATEGORY_SUBFOLDER[cat]!;
    const actionSkips = skipFiles.get(action.source) || new Set();

    if (action.action === "copy") {
      const filename = basename(action.source);
      if (actionSkips.has(filename)) continue;
      const targetKey = `events/${code}/${subfolder}/${filename}`;
      // For copy actions we don't have uncompressed size in the action,
      // find it from the files list
      const fileEntry = evt.files.find(
        (f) => f.relativePath === action.source,
      );
      if (fileEntry) {
        result.set(targetKey, 0); // size 0 = unknown for loose files
      }
    } else if (action.action === "extract_zip") {
      // Find the zip's contents from the files list
      const zipFile = evt.files.find(
        (f) => f.relativePath === action.source,
      );
      if (!zipFile?.zipContents) continue;

      for (const entry of zipFile.zipContents) {
        if (!AUDIO_EXTENSIONS.has(entry.type)) continue;
        const filename = basename(entry.name);
        if (actionSkips.has(filename)) continue;
        const targetKey = `events/${code}/${subfolder}/${filename}`;
        result.set(targetKey, entry.uncompressedSize);
      }
    }
  }

  return result;
}

async function main() {
  console.log("=== Sync S3 Keys (from inventory) ===");
  if (isDryRun) console.log("(Dry run — no DB updates)\n");

  // 1. Load inventory
  console.log("[1/3] Loading inventory...");
  const inventory = JSON.parse(readFileSync(INVENTORY_PATH, "utf-8"));
  const invEvents: InventoryEvent[] = inventory.events;
  console.log(`  ${invEvents.length} events in inventory`);

  // Build canonical code → target keys map
  const targetKeysByEvent = new Map<string, Map<string, number>>();
  let totalTargetKeys = 0;
  for (const evt of invEvents) {
    const keys = buildTargetKeys(evt);
    if (keys.size > 0) {
      targetKeysByEvent.set(evt.canonicalCode, keys);
      totalTargetKeys += keys.size;
    }
  }
  console.log(
    `  ${targetKeysByEvent.size} events with audio, ${totalTargetKeys} target keys\n`,
  );

  // 2. Load DB tracks grouped by event
  console.log("[2/3] Loading DB tracks...");
  const dbTracks = await db
    .select({
      id: tracks.id,
      s3Key: tracks.s3Key,
      title: tracks.title,
      fileSizeBytes: tracks.fileSizeBytes,
      originalFilename: tracks.originalFilename,
      eventCode: events.eventCode,
    })
    .from(tracks)
    .innerJoin(sessions, eq(tracks.sessionId, sessions.id))
    .innerJoin(events, eq(sessions.eventId, events.id));
  console.log(`  ${dbTracks.length} tracks\n`);

  // 3. Match and fix
  console.log("[3/3] Syncing...");
  let alreadyCorrect = 0;
  let fixed = 0;
  let noInventory = 0;
  let noMatch = 0;

  for (const track of dbTracks) {
    const targetKeys = targetKeysByEvent.get(track.eventCode!);
    if (!targetKeys) {
      noInventory++;
      continue;
    }

    // Check if current key is already a valid target
    if (track.s3Key && targetKeys.has(track.s3Key)) {
      alreadyCorrect++;
      continue;
    }

    // Try to find the correct target key by original filename
    const origFilename =
      track.originalFilename || track.s3Key?.split("/").pop();
    if (!origFilename) {
      noMatch++;
      continue;
    }

    // Look for a target key ending with this filename
    let matchedKey: string | null = null;
    for (const [targetKey] of targetKeys) {
      if (targetKey.endsWith("/" + origFilename)) {
        matchedKey = targetKey;
        break;
      }
    }

    if (!matchedKey) {
      // Try case-insensitive
      const lowerOrig = origFilename.toLowerCase();
      for (const [targetKey] of targetKeys) {
        if (targetKey.toLowerCase().endsWith("/" + lowerOrig)) {
          matchedKey = targetKey;
          break;
        }
      }
    }

    if (!matchedKey) {
      // Strip _EN/_PT suffix added during Wix import and retry
      // e.g. "042 jkr - the power of awakening_EN.mp3" → "042 jkr - the power of awakening.mp3"
      const strippedFn = origFilename.replace(/_(EN|PT)(\.\w+)$/i, "$2");
      if (strippedFn !== origFilename) {
        const lowerStripped = strippedFn.toLowerCase();
        for (const [targetKey] of targetKeys) {
          if (targetKey.toLowerCase().endsWith("/" + lowerStripped)) {
            matchedKey = targetKey;
            break;
          }
        }
      }
    }

    if (!matchedKey) {
      noMatch++;
      continue;
    }

    if (matchedKey === track.s3Key) {
      alreadyCorrect++;
      continue;
    }

    console.log(`FIX: [${track.id}] ${track.title}`);
    console.log(`  OLD: ${track.s3Key}`);
    console.log(`  NEW: ${matchedKey}`);

    if (!isDryRun) {
      await db
        .update(tracks)
        .set({ s3Key: matchedKey, updatedAt: new Date() })
        .where(eq(tracks.id, track.id));
    }
    fixed++;
  }

  console.log(`\n=== Results ===`);
  console.log(`Already correct: ${alreadyCorrect}`);
  console.log(`Fixed:           ${fixed}`);
  console.log(`No inventory:    ${noInventory} (event not in inventory)`);
  console.log(`No match:        ${noMatch} (filename not in inventory targets)`);
  console.log(`Total DB tracks: ${dbTracks.length}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
