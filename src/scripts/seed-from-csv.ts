/**
 * Seed script: Extract unique teachers, places, and retreat groups from the Wix CSV
 * and insert them into the database.
 *
 * Usage: bun run src/scripts/seed-from-csv.ts <path-to-csv>
 */

import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import { db } from "../db/index.ts";
import { teachers } from "../db/schema/teachers.ts";
import { places } from "../db/schema/places.ts";
import { retreatGroups } from "../db/schema/retreat-groups.ts";
import {
  parseWixRow,
  parseTeachers,
  parseOrganizations,
  teacherAbbreviation,
} from "./csv-parser.ts";

const csvPath = process.argv[2] ?? process.argv[1]; // handle bun vs node
if (!csvPath || csvPath.endsWith(".ts")) {
  console.error("Usage: bun run src/scripts/seed-from-csv.ts <path-to-csv>");
  process.exit(1);
}

const csvContent = readFileSync(csvPath, "utf-8").replace(/^\uFEFF/, ""); // strip BOM
const rawRows: Record<string, string>[] = parse(csvContent, {
  columns: true,
  skip_empty_lines: true,
  relax_column_count: true,
});

console.log(`Parsed ${rawRows.length} rows from CSV`);

// --- Extract unique entities ---

const teacherSet = new Map<string, string>(); // name → abbreviation
const placeSet = new Set<string>();
const orgSet = new Set<string>();

for (const raw of rawRows) {
  const row = parseWixRow(raw);

  for (const t of parseTeachers(row.teacherName)) {
    if (!teacherSet.has(t)) {
      teacherSet.set(t, teacherAbbreviation(t));
    }
  }

  if (row.guestName) {
    teacherSet.set(row.guestName, teacherAbbreviation(row.guestName));
  }

  if (row.place) placeSet.add(row.place);

  for (const o of parseOrganizations(row.organization)) {
    orgSet.add(o);
  }
}

console.log(`\nFound unique entities:`);
console.log(`  Teachers: ${teacherSet.size}`);
console.log(`  Places:   ${placeSet.size}`);
console.log(`  Groups:   ${orgSet.size}`);

// --- Insert into database ---

console.log("\nSeeding teachers...");
for (const [name, abbrev] of teacherSet) {
  await db
    .insert(teachers)
    .values({ name, abbreviation: abbrev })
    .onConflictDoNothing();
}
console.log(`  Inserted ${teacherSet.size} teachers`);

console.log("Seeding places...");
for (const location of placeSet) {
  // Extract a short name from the full location string
  const shortName = location.split(",")[0]!.trim();
  await db
    .insert(places)
    .values({ name: shortName, location })
    .onConflictDoNothing();
}
console.log(`  Inserted ${placeSet.size} places`);

console.log("Seeding retreat groups...");
let order = 0;
for (const orgName of orgSet) {
  const slug = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  await db
    .insert(retreatGroups)
    .values({
      nameEn: orgName,
      namePt: orgName,
      slug,
      displayOrder: order++,
    })
    .onConflictDoNothing();
}
console.log(`  Inserted ${orgSet.size} groups`);

console.log("\nSeed complete!");
process.exit(0);
