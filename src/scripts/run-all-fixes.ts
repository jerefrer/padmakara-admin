/**
 * Master script to run all database fixes in sequence
 * Run with --dry-run to preview changes
 */

import { execSync } from "child_process";

const DRY_RUN = process.argv.includes("--dry-run");
const bunPath = "/Users/jeremy/.bun/bin/bun";

console.log("=".repeat(60));
console.log("TRACK CLEANUP & STANDARDIZATION");
console.log("=".repeat(60));
console.log(`Mode: ${DRY_RUN ? "DRY RUN (preview only)" : "LIVE (will modify database)"}\n`);

const scripts = [
  {
    name: "001 - Add Track Fields",
    path: "src/scripts/migrations/001-add-track-fields.ts",
    description: "Add isPractice and fileFormat columns to tracks table",
  },
  {
    name: "002 - Transcripts Event-Level Only",
    path: "src/scripts/migrations/002-transcripts-event-level-only.ts",
    description: "Remove session_id from transcripts (transcripts are event-level only)",
  },
  {
    name: "003 - Fix Zoom Translations",
    path: "src/scripts/fix-zoom-translations.ts",
    description: "Fix translation flags for Zoom recordings",
  },
  {
    name: "004 - Clean Video Filenames",
    path: "src/scripts/clean-video-filenames.ts",
    description: "Remove .mp4 extension from filenames (format stored in file_format)",
  },
  {
    name: "005 - Split AM/PM Sessions",
    path: "src/scripts/split-ampm-sessions.ts",
    description: "Split tracks with AM/PM into separate morning/afternoon sessions",
    dryRunFlag: true,
  },
];

for (let i = 0; i < scripts.length; i++) {
  const script = scripts[i];
  console.log(`\n[${ i + 1}/${scripts.length}] ${script.name}`);
  console.log(`Description: ${script.description}`);
  console.log("-".repeat(60));

  try {
    const cmd = script.dryRunFlag && DRY_RUN
      ? `${bunPath} run ${script.path} --dry-run`
      : `${bunPath} run ${script.path}`;

    execSync(cmd, {
      stdio: "inherit",
      cwd: "/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api",
    });

    console.log(`✅ ${script.name} completed\n`);
  } catch (error) {
    console.error(`❌ ${script.name} failed\n`);
    console.error(error);
    process.exit(1);
  }
}

console.log("\n" + "=".repeat(60));
console.log("ALL FIXES COMPLETED SUCCESSFULLY");
console.log("=".repeat(60));

if (DRY_RUN) {
  console.log("\n[DRY RUN] No changes were made to the database");
  console.log("Run without --dry-run to apply all changes");
} else {
  console.log("\n✅ All database changes applied successfully");
  console.log("\nNext steps:");
  console.log("1. Update UI components to display new fields (isPractice, fileFormat)");
  console.log("2. Run check-transcript-only-events.ts to import missing media");
  console.log("3. Test admin interface for proper display of all changes");
}
