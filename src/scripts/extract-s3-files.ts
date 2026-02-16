/**
 * S3 Extraction Script: Extract ZIP files from old bucket to new backend structure.
 *
 * This script:
 * 1. Reads migration validation report
 * 2. Identifies events with ZIP_ONLY or PARTIAL state
 * 3. Triggers Lambda to extract ZIPs from "padmakara-pt" bucket
 * 4. Writes individual MP3s to "padmakara-pt-sample" bucket
 * 5. Organizes files according to new backend structure
 *
 * File Structure (New Backend):
 *   padmakara-pt-sample/
 *   ├── mediateca/
 *   │   ├── {EVENT-CODE}/
 *   │   │   ├── track001.mp3
 *   │   │   ├── track002.mp3
 *   │   │   └── audio2/          ← Translations
 *   │   │       ├── track001.mp3
 *   │   │       └── track002.mp3
 *
 * Usage:
 *   bun run src/scripts/extract-s3-files.ts migration-report.json
 *   bun run src/scripts/extract-s3-files.ts migration-report.json --limit 10
 *   bun run src/scripts/extract-s3-files.ts migration-report.json --event-code 20100308-MTR-CFR-ACM
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { triggerZipExtraction, extractS3Prefix, BUCKET } from "./s3-utils.ts";

interface ExtractionArgs {
  reportPath: string;
  limit: number | null;
  eventCode: string | null;
  dryRun: boolean;
}

function parseArgs(): ExtractionArgs {
  const args = process.argv.slice(2);

  const reportPath = args.find((a) => !a.startsWith("--"));
  if (!reportPath) {
    console.error("Usage: bun run src/scripts/extract-s3-files.ts <report.json> [options]");
    console.error("Options:");
    console.error("  --limit N          Extract only N events");
    console.error("  --event-code CODE  Extract specific event only");
    console.error("  --dry-run          Show what would be extracted without executing");
    process.exit(1);
  }

  return {
    reportPath,
    limit: args.includes("--limit")
      ? parseInt(args[args.indexOf("--limit") + 1]!, 10)
      : null,
    eventCode: args.includes("--event-code")
      ? args[args.indexOf("--event-code") + 1]!
      : null,
    dryRun: args.includes("--dry-run"),
  };
}

const cliArgs = parseArgs();

if (!existsSync(cliArgs.reportPath)) {
  console.error(`❌ Report file not found: ${cliArgs.reportPath}`);
  console.error("Run validation first: bun run src/scripts/migrate-from-wix-v2.ts CSV --validate-only");
  process.exit(1);
}

// Load validation report
const report = JSON.parse(readFileSync(cliArgs.reportPath, "utf-8"));

console.log("📊 S3 Extraction Analysis");
console.log("=".repeat(80));
console.log(`Target Bucket: ${BUCKET}`);
console.log(`Total Events: ${Object.keys(report.s3States ?? {}).length}`);

// Filter events needing extraction
const eventsNeedingExtraction: Array<{
  eventCode: string;
  state: string;
  zipUrl: string;
  prefix: string;
  expectedTracks: number;
}> = [];

for (const [eventCode, s3State] of Object.entries(report.s3States ?? {}) as any) {
  if (!s3State.zipUrl) continue;

  // Skip if specific event requested and this isn't it
  if (cliArgs.eventCode && eventCode !== cliArgs.eventCode) continue;

  // Extract events with ZIP_ONLY or PARTIAL state
  if (s3State.state === "ZIP_ONLY" || s3State.state === "PARTIAL") {
    const prefix = extractS3Prefix(s3State.zipUrl);
    if (prefix) {
      eventsNeedingExtraction.push({
        eventCode,
        state: s3State.state,
        zipUrl: s3State.zipUrl,
        prefix,
        expectedTracks: s3State.expectedTrackCount,
      });
    }
  }
}

console.log(`\nEvents Needing Extraction: ${eventsNeedingExtraction.length}`);
console.log(`  ZIP_ONLY: ${eventsNeedingExtraction.filter((e) => e.state === "ZIP_ONLY").length}`);
console.log(`  PARTIAL:  ${eventsNeedingExtraction.filter((e) => e.state === "PARTIAL").length}`);

if (eventsNeedingExtraction.length === 0) {
  console.log("\n✅ All events already extracted! No work needed.");
  process.exit(0);
}

// Apply limit
const toExtract = cliArgs.limit
  ? eventsNeedingExtraction.slice(0, cliArgs.limit)
  : eventsNeedingExtraction;

console.log(`\nProcessing: ${toExtract.length} events`);

if (cliArgs.dryRun) {
  console.log("\n=== DRY RUN MODE ===");
  console.log("Would extract the following:");
  for (const event of toExtract) {
    console.log(`  ${event.eventCode}: ${event.expectedTracks} tracks from ${event.zipUrl}`);
  }
  process.exit(0);
}

console.log("\n" + "=".repeat(80));
console.log("🚀 Starting Extraction");
console.log("=".repeat(80) + "\n");

// Extraction state
const extractionResults: Array<{
  eventCode: string;
  success: boolean;
  message: string;
  timestamp: string;
}> = [];

for (let i = 0; i < toExtract.length; i++) {
  const event = toExtract[i]!;
  console.log(`\n[${i + 1}/${toExtract.length}] ${event.eventCode}`);
  console.log(`  Source: ${event.zipUrl}`);
  console.log(`  Target: ${BUCKET}/${event.prefix}/`);
  console.log(`  Expected tracks: ${event.expectedTracks}`);

  try {
    const result = await triggerZipExtraction(
      event.zipUrl,
      event.prefix,
      BUCKET,
    );

    extractionResults.push({
      eventCode: event.eventCode,
      success: result.success,
      message: result.message,
      timestamp: new Date().toISOString(),
    });

    if (result.success) {
      console.log(`  ✅ ${result.message}`);
    } else {
      console.log(`  ❌ ${result.message}`);
    }

    // Add delay between Lambda invocations to avoid throttling
    if (i < toExtract.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (err: any) {
    console.error(`  ❌ Error: ${err.message}`);
    extractionResults.push({
      eventCode: event.eventCode,
      success: false,
      message: err.message,
      timestamp: new Date().toISOString(),
    });
  }
}

// Save extraction report
const extractionReport = {
  timestamp: new Date().toISOString(),
  targetBucket: BUCKET,
  totalProcessed: toExtract.length,
  successful: extractionResults.filter((r) => r.success).length,
  failed: extractionResults.filter((r) => !r.success).length,
  results: extractionResults,
};

const reportFile = "extraction-report.json";
writeFileSync(reportFile, JSON.stringify(extractionReport, null, 2), "utf-8");

// Summary
console.log("\n" + "=".repeat(80));
console.log("📊 EXTRACTION SUMMARY");
console.log("=".repeat(80));
console.log(`Total Processed: ${extractionReport.totalProcessed}`);
console.log(`Successful:      ${extractionReport.successful}`);
console.log(`Failed:          ${extractionReport.failed}`);
console.log(`\nReport saved: ${reportFile}`);
console.log("=".repeat(80) + "\n");

if (extractionReport.failed > 0) {
  console.log("❌ Some extractions failed. Check extraction-report.json for details.\n");
  process.exit(1);
}

console.log("✅ All extractions completed successfully!\n");
console.log("Next steps:");
console.log("  1. Verify files in S3: aws s3 ls s3://padmakara-pt-sample/mediateca/");
console.log("  2. Re-run validation: bun run src/scripts/migrate-from-wix-v2.ts CSV --validate-only");
console.log("  3. Run migration: bun run src/scripts/migrate-from-wix-v2.ts CSV\n");
