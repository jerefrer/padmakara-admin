/**
 * Check transcript-only events and import missing media files if they exist in S3
 */

import { readFileSync } from "fs";
import { db } from "../db/index.ts";

console.log("=== Check Transcript-Only Events ===\n");

// Events with transcripts but no tracks
const transcriptOnlyEvents = [
  "20061120-JKR-CFR-UBP",
  "202005-JKR-PBD-VID",
  "202010-PWR-Todos-VID",
  "202012-KPS-PP2-VID",
  "202012-KPS-PP3-VID",
  "202012-KPS-PP4-VID",
  "202105-JKR- Todos-VID",
];

// Load s3-inventory.json
const inventoryPath = "/Users/jeremy/Documents/Programming/padmakara-backend-frontend/scripts/migration/s3-inventory.json";
const inventoryData = JSON.parse(readFileSync(inventoryPath, "utf-8"));
const inventory = inventoryData.events || [];

for (const eventCode of transcriptOnlyEvents) {
  console.log(`\nChecking ${eventCode}...`);

  // Find in database
  const event = await db.query.events.findFirst({
    where: (e, { eq }) => eq(e.eventCode, eventCode),
    with: {
      transcripts: true,
      sessions: {
        with: {
          tracks: true,
        },
      },
    },
  });

  if (!event) {
    console.log(`  ❌ Not found in database`);
    continue;
  }

  console.log(`  ✓ Found in database`);
  console.log(`  Transcripts: ${event.transcripts.length}`);
  console.log(`  Sessions: ${event.sessions.length}`);
  console.log(`  Tracks: ${event.sessions.reduce((sum, s) => sum + s.tracks.length, 0)}`);

  // Check S3 inventory
  const invEvent = inventory.find((e: any) => e.canonicalCode === eventCode);

  if (!invEvent) {
    console.log(`  ❌ Not found in S3 inventory`);
    continue;
  }

  console.log(`  ✓ Found in S3 inventory`);
  console.log(`  Files in S3:`);

  // List all non-PDF files
  const mediaFiles = invEvent.files.filter((f: any) => {
    const ext = f.type.toLowerCase();
    return ext !== ".pdf" && ext !== ".zip" && ext !== "" && ext !== ".db";
  });

  if (mediaFiles.length === 0) {
    console.log(`    No media files found (only PDFs/zips)`);
  } else {
    console.log(`    Found ${mediaFiles.length} media files:`);
    for (const file of mediaFiles.slice(0, 5)) {
      console.log(`      - ${file.relativePath} (${file.type})`);
    }
    if (mediaFiles.length > 5) {
      console.log(`      ... and ${mediaFiles.length - 5} more`);
    }
    console.log(`\n  ⚠️  Media files exist but not imported!`);
  }

  // Check for files in zip contents
  for (const file of invEvent.files) {
    if (file.zipContents && file.zipContents.length > 0) {
      const mediaInZip = file.zipContents.filter((z: any) => {
        const ext = z.type.toLowerCase();
        return ext !== ".pdf" && ext !== "";
      });

      if (mediaInZip.length > 0) {
        console.log(`\n  Files in ${file.relativePath}:`);
        for (const zipFile of mediaInZip.slice(0, 3)) {
          console.log(`      - ${zipFile.name} (${zipFile.type})`);
        }
        if (mediaInZip.length > 3) {
          console.log(`      ... and ${mediaInZip.length - 3} more`);
        }
      }
    }
  }
}

console.log("\n=== Summary ===");
console.log("Events with media files in S3 that need to be imported:");
console.log("- Check output above for events marked with ⚠️");
console.log("\nNext steps:");
console.log("1. Run the seed script for these specific events");
console.log("2. Or create a targeted import script for these events");
