/**
 * Seed script: Extract unique teachers, places, retreat groups, event types,
 * and audiences from the Wix CSV and insert them into the database.
 *
 * Usage: bun run src/scripts/seed-from-csv.ts <path-to-csv>
 */

import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { teachers } from "../db/schema/teachers.ts";
import { places } from "../db/schema/places.ts";
import { retreatGroups } from "../db/schema/retreat-groups.ts";
import { eventTypes } from "../db/schema/event-types.ts";
import { audiences } from "../db/schema/audiences.ts";
import { slugify } from "../lib/slugify.ts";
import {
  parseWixRow,
  parseTeachers,
  teacherAbbreviation,
  designationToGroup,
  TEACHER_ALIASES,
  UNKNOWN_TEACHERS,
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

// --- Abbreviation map for event types (derived from old designation codes) ---

const DESIGNATION_ABBREV: Record<string, string> = {
  "Śamatha": "SHA",
  "Śamatha + Introdução à Via": "SHA-INTV",
  "Treino da Mente 1": "TM1",
  "Treino da Mente 2": "TM2",
  "Treino da Mente (Pr. dos Bodhisattvas)": "TM",
  "Práticas Preliminares - Nível 1": "PP1",
  "Práticas Preliminares - Nível 2": "PP2",
  "Práticas Preliminares - Nível 3": "PP3",
  "Práticas Preliminares - Nível 4": "PP4",
  "Conferência": "CFR",
  "Ensinamento": "ENS",
  "Ensinamento Restrito": "ERT",
  "Práticas dos Bodhisattvas": "PBD",
  "Prática de Buda Śākyamuni": "PBS",
};

// --- Designations that are genuine event types (not retreat groups) ---
const EVENT_TYPE_DESIGNATIONS = new Set([
  "Conferência",
  "Ensinamento",
  "Ensinamento Restrito",
]);

// --- Extract unique entities ---

const teacherSet = new Map<string, string>(); // name → abbreviation
const placeSet = new Set<string>();
const eventTypeSet = new Map<string, { namePt: string; nameEn: string }>(); // designation → names

// --- Audiences: fixed list in display order ---
const AUDIENCES: { nameEn: string; namePt: string }[] = [
  { nameEn: "Free (anyone)", namePt: "Livre (qualquer pessoa)" },
  { nameEn: "Free (subscribers)", namePt: "Livre (assinantes)" },
  { nameEn: "Event participants", namePt: "Participantes no evento" },
  { nameEn: "Retreat group members", namePt: "Membros do grupo de retiro" },
  { nameEn: "Received initiation", namePt: "Recebeu iniciação" },
  { nameEn: "Available on request only", namePt: "Disponível apenas a pedido" },
];

// --- Retreat groups: fixed list in display order ---
const RETREAT_GROUPS: { nameEn: string; namePt: string; abbreviation: string }[] = [
  { nameEn: "Śamatha", namePt: "Śamatha", abbreviation: "SHA" },
  { nameEn: "Śamatha + Introduction to the Path", namePt: "Śamatha + Introdução à Via", abbreviation: "SHA-IV" },
  { nameEn: "Buddha Śākyamuni Practice", namePt: "Prática de Buda Śākyamuni", abbreviation: "PBS" },
  { nameEn: "Bodhisattva Practices", namePt: "Práticas dos Bodhisattvas", abbreviation: "PBD" },
  { nameEn: "Mind Training (Bodhisattva Practices)", namePt: "Treino da Mente (Pr. dos Bodhisattvas)", abbreviation: "TM" },
  { nameEn: "Mind Training 1", namePt: "Treino da Mente 1", abbreviation: "TM1" },
  { nameEn: "Mind Training 2", namePt: "Treino da Mente 2", abbreviation: "TM2" },
  { nameEn: "Preliminary Practices - Level 1 - Refuge & Bodhicitta", namePt: "Práticas Preliminares - Nível 1 - Refúgio & Bodhicitta", abbreviation: "PP1" },
  { nameEn: "Preliminary Practices - Level 2 - Vajrasattva", namePt: "Práticas Preliminares - Nível 2 - Vajrasattva", abbreviation: "PP2" },
  { nameEn: "Preliminary Practices - Level 3 - Mandala", namePt: "Práticas Preliminares - Nível 3 - Mandala", abbreviation: "PP3" },
  { nameEn: "Preliminary Practices - Level 4 - Guru Yoga", namePt: "Práticas Preliminares - Nível 4 - Guru Yoga", abbreviation: "PP4" },
];

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

  if (row.designation && EVENT_TYPE_DESIGNATIONS.has(row.designation)) {
    if (!eventTypeSet.has(row.designation)) {
      const group = designationToGroup(row.designation);
      eventTypeSet.set(row.designation, group ?? { namePt: row.designation, nameEn: row.designation });
    }
  }

}

console.log(`\nFound unique entities:`);
console.log(`  Teachers:    ${teacherSet.size}`);
console.log(`  Places:      ${placeSet.size}`);
console.log(`  Groups:      ${RETREAT_GROUPS.length}`);
console.log(`  Event types: ${eventTypeSet.size}`);
console.log(`  Audiences:   ${AUDIENCES.length}`);

// --- Insert into database ---

console.log("\nSeeding teachers...");
for (const [name, abbrev] of teacherSet) {
  const aliases = TEACHER_ALIASES[abbrev] ?? [];
  await db
    .insert(teachers)
    .values({ name, abbreviation: abbrev, aliases })
    .onConflictDoNothing();
}
// Insert unknown teachers (abbreviations found in tracks but not mappable to known names)
let unknownIdx = 1;
for (const ut of UNKNOWN_TEACHERS) {
  await db
    .insert(teachers)
    .values({
      name: `UNKNOWN TEACHER ${unknownIdx}`,
      abbreviation: ut.abbreviation,
      aliases: ut.aliases,
    })
    .onConflictDoNothing();
  unknownIdx++;
}
console.log(`  Inserted ${teacherSet.size} teachers + ${UNKNOWN_TEACHERS.length} unknown`);

console.log("Seeding places...");
for (const location of placeSet) {
  let shortName = location.split(",")[0]!.trim();
  let abbreviation: string | undefined;

  // Map "Vídeo" to "Online" with ZOOM abbreviation
  if (shortName === "Vídeo") {
    shortName = "Online";
    abbreviation = "ZOOM";
  }

  await db
    .insert(places)
    .values({ name: shortName, abbreviation, location })
    .onConflictDoNothing();
}

// Set abbreviations for known places
const PLACE_ABBREVIATIONS: Record<string, string> = {
  "Karuna": "KAR",
  "Centro de Retiros do Covão da Águia": "CCA",
  "UBP": "UBP",
  "Hotel do Sado": "HSA",
  "Hotel Marriott": "HMA",
  "Hotel Altis": "HAL",
  "Palácio Villa Helena": "VLH",
  "La Várzea": "LVZ",
  "Seminário Torre da Aguilha": "STA",
};

for (const [placeName, abbrev] of Object.entries(PLACE_ABBREVIATIONS)) {
  await db
    .update(places)
    .set({ abbreviation: abbrev })
    .where(eq(places.name, placeName));
}
console.log(`  Inserted ${placeSet.size} places (with abbreviations)`);

console.log("Seeding retreat groups...");
for (let i = 0; i < RETREAT_GROUPS.length; i++) {
  const group = RETREAT_GROUPS[i]!;
  await db
    .insert(retreatGroups)
    .values({
      nameEn: group.nameEn,
      namePt: group.namePt,
      abbreviation: group.abbreviation,
      slug: slugify(group.nameEn),
      displayOrder: i,
    })
    .onConflictDoNothing();
}
console.log(`  Inserted ${RETREAT_GROUPS.length} groups`);

console.log("Seeding event types...");
let etOrder = 0;
for (const [designation, names] of eventTypeSet) {
  const abbrev = DESIGNATION_ABBREV[designation] ?? slugify(designation).substring(0, 10).toUpperCase();
  await db
    .insert(eventTypes)
    .values({
      nameEn: names.nameEn,
      namePt: names.namePt,
      abbreviation: abbrev,
      slug: slugify(names.nameEn),
      displayOrder: etOrder++,
    })
    .onConflictDoNothing();
}
// Add "Parallel Retreats" event type (not derived from CSV designations)
await db
  .insert(eventTypes)
  .values({
    nameEn: "Parallel Retreats",
    namePt: "Retiros Paralelos",
    abbreviation: "RET",
    slug: "parallel-retreats",
    displayOrder: etOrder++,
  })
  .onConflictDoNothing();
console.log(`  Inserted ${eventTypeSet.size + 1} event types`);

console.log("Seeding audiences...");
for (let i = 0; i < AUDIENCES.length; i++) {
  const aud = AUDIENCES[i]!;
  await db
    .insert(audiences)
    .values({
      nameEn: aud.nameEn,
      namePt: aud.namePt,
      slug: slugify(aud.nameEn),
      displayOrder: i,
    })
    .onConflictDoNothing();
}
console.log(`  Inserted ${AUDIENCES.length} audiences`);

console.log("\nSeed complete!");
process.exit(0);
