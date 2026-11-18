/**
 * Import the main teachers / guests split and the guest intro phrase from the old
 * Wix database export (columns `teacherName`, `guestName`, `Aux-introGuest`).
 *
 *   bun run src/scripts/import-wix-guests.ts [--csv <path>]            # dry run (default)
 *   bun run src/scripts/import-wix-guests.ts [--csv <path>] --apply    # write
 *
 * The CSV defaults to ../wix-export-20250821.csv (next to padmakara-api/).
 *
 * Only Wix rows that name a guest or an intro phrase are considered. Each is
 * matched to an event by Wix ID (`retreats.wix_id`), else by event code
 * (punctuation-insensitive). Names are matched to the teachers table by name,
 * abbreviation or alias (accents and case ignored), then, only if exactly one
 * teacher fits, by a partial name ("Rabjam Rinpoche" → "Shechen Rabjam
 * Rinpoche", "K. Trulshik Rinpoche" → "Kyabje Trulshik Rinpoche"); those are
 * flagged "~" in the report. Nothing is guessed: an event with an unmatched or
 * ambiguous name, an unknown intro phrase or no matching event is reported and
 * left alone.
 *
 * For a matched event the new teacher list is: the Wix main teachers, in Wix
 * order, then the Wix guests, then any teacher the event already has that Wix
 * does not list (kept with its current role, reported as "kept"). Its guest intro
 * becomes the Wix phrase (an empty phrase = null = default rendering). Events
 * already in that state are reported "unchanged" and not written, so the script
 * can be re-run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { parseTeachers } from "./csv-parser.ts";
import { canonicalCode, findTeacher, fold, type RefTeacher } from "../services/library-records.ts";
import { GUEST_INTRO_LABELS, guestIntroFromWix, type GuestIntro } from "../lib/guest-intro.ts";
import { GUEST_ROLE, orderEventTeachers } from "../lib/event-teacher-order.ts";

// ─── Parsing ─────────────────────────────────────────────────────────────

export interface WixGuestRow {
  wixId: string;
  eventCode: string;
  mainNames: string[];
  guestNames: string[];
  /** The phrase as written in Wix ("" when none). */
  introRaw: string;
  /** Its key; null = none (default rendering); undefined = a phrase we do not know. */
  intro: GuestIntro | null | undefined;
}

/** Rows of the Wix export that name a guest or an intro phrase. */
export function parseWixGuestRows(csvText: string): WixGuestRow[] {
  const raw: Record<string, string>[] = parse(csvText.replace(/^﻿/, ""), {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
  return raw
    .map((r) => {
      const introRaw = (r["Aux-introGuest"] ?? "").trim();
      return {
        wixId: (r["ID"] ?? "").trim(),
        eventCode: (r["eventCode"] ?? "").trim(),
        // Several people are listed "A | B". Never split on ",": a name can hold one
        // ("42º Sakya Trizin, Ratna Vajra Rinpoche").
        mainNames: parseTeachers(r["teacherName"] ?? ""),
        guestNames: parseTeachers(r["guestName"] ?? ""),
        introRaw,
        intro: guestIntroFromWix(introRaw),
      };
    })
    .filter((r) => r.guestNames.length > 0 || r.introRaw !== "");
}

// ─── Matching ────────────────────────────────────────────────────────────

export type TeacherMatch =
  | { kind: "exact"; teacher: RefTeacher }
  | { kind: "partial"; teacher: RefTeacher }
  | { kind: "ambiguous"; candidates: RefTeacher[] }
  | { kind: "none" };

/** "k" (from "K.") matches a word starting with k; any other word must be equal. */
function wordFits(word: string, words: string[]): boolean {
  return word.length === 1 ? words.some((w) => w.startsWith(word)) : words.includes(word);
}

/** Words that alone do not identify anyone. */
const GENERIC_WORDS = new Set(["rinpoche", "lama", "khenpo", "khenchen", "kyabje", "dr", "s", "ss"]);

export function matchTeacherName(name: string, teachers: RefTeacher[]): TeacherMatch {
  const exact = findTeacher(name, teachers);
  if (exact) return { kind: "exact", teacher: exact };

  const words = fold(name).split(" ").filter(Boolean);
  const distinctive = words.filter((w) => w.length > 1 && !GENERIC_WORDS.has(w));
  if (words.length < 2 || distinctive.length === 0) return { kind: "none" };
  const candidates = teachers.filter((t) => {
    const tw = fold(t.name).split(" ").filter(Boolean);
    return words.every((w) => wordFits(w, tw));
  });
  if (candidates.length === 1) return { kind: "partial", teacher: candidates[0]! };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "none" };
}

export interface EventLink {
  teacherId: number;
  role: string;
  position: number;
  teacher: { name: string };
}

export interface CandidateEvent {
  id: number;
  eventCode: string;
  wixId: string | null;
  guestIntro: string | null;
  eventTeachers: EventLink[];
}

/** The event a Wix row describes: by Wix ID, else by event code. Several by code = ambiguous. */
export function matchEvent(
  row: Pick<WixGuestRow, "wixId" | "eventCode">,
  events: CandidateEvent[],
): { event: CandidateEvent; by: "wixId" | "code" } | { event: null; ambiguous: CandidateEvent[] } {
  const byWix = row.wixId ? events.find((e) => e.wixId === row.wixId) : undefined;
  if (byWix) return { event: byWix, by: "wixId" };
  const code = canonicalCode(row.eventCode);
  const byCode = code ? events.filter((e) => canonicalCode(e.eventCode) === code) : [];
  if (byCode.length === 1) return { event: byCode[0]!, by: "code" };
  return { event: null, ambiguous: byCode };
}

// ─── Planning ────────────────────────────────────────────────────────────

export interface PlannedLink {
  teacherId: number;
  name: string;
  role: string;
  /** "~" = matched on a partial name; "kept" = not in Wix, left as it was. */
  note?: "~" | "kept";
}

export type Plan =
  | { status: "no-event"; row: WixGuestRow; ambiguous: string[] }
  | { status: "unmatched"; row: WixGuestRow; event: CandidateEvent; problems: string[] }
  | {
      status: "change" | "unchanged";
      row: WixGuestRow;
      event: CandidateEvent;
      matchedBy: "wixId" | "code";
      current: { links: PlannedLink[]; guestIntro: string | null };
      proposed: { links: PlannedLink[]; guestIntro: GuestIntro | null };
    };

export function planRow(row: WixGuestRow, events: CandidateEvent[], teachers: RefTeacher[]): Plan {
  const found = matchEvent(row, events);
  if (!found.event) return { status: "no-event", row, ambiguous: found.ambiguous.map((e) => e.eventCode) };
  const event = found.event;

  const problems: string[] = [];
  if (row.intro === undefined) problems.push(`unknown intro phrase "${row.introRaw}"`);

  const proposedLinks: PlannedLink[] = [];
  const add = (names: string[], role: string) => {
    for (const name of names) {
      const m = matchTeacherName(name, teachers);
      if (m.kind === "none") {
        problems.push(`no teacher named "${name}"`);
      } else if (m.kind === "ambiguous") {
        problems.push(`"${name}" could be ${m.candidates.map((c) => c.name).join(" or ")}`);
      } else if (!proposedLinks.some((l) => l.teacherId === m.teacher.id)) {
        proposedLinks.push({
          teacherId: m.teacher.id,
          name: m.teacher.name,
          role,
          ...(m.kind === "partial" ? { note: "~" as const } : {}),
        });
      }
    }
  };
  add(row.mainNames, "teacher");
  add(row.guestNames, GUEST_ROLE);
  if (problems.length > 0) return { status: "unmatched", row, event, problems };

  const currentLinks: PlannedLink[] = orderEventTeachers(event.eventTeachers).map((et) => ({
    teacherId: et.teacherId,
    name: et.teacher.name,
    role: et.role,
  }));
  for (const link of currentLinks) {
    if (!proposedLinks.some((l) => l.teacherId === link.teacherId)) proposedLinks.push({ ...link, note: "kept" });
  }
  const proposed = { links: orderEventTeachers(proposedLinks), guestIntro: row.intro ?? null };

  const same =
    proposed.guestIntro === (event.guestIntro ?? null) &&
    proposed.links.length === currentLinks.length &&
    proposed.links.every((l, i) => l.teacherId === currentLinks[i]!.teacherId && l.role === currentLinks[i]!.role);

  return {
    status: same ? "unchanged" : "change",
    row,
    event,
    matchedBy: found.by,
    current: { links: currentLinks, guestIntro: event.guestIntro ?? null },
    proposed,
  };
}

// ─── Report ──────────────────────────────────────────────────────────────

function describe(links: PlannedLink[], guestIntro: string | null): string {
  const label = (l: PlannedLink) => `${l.name}${l.note === "~" ? " ~" : ""}${l.note === "kept" ? " (kept)" : ""}`;
  const main = links.filter((l) => l.role !== GUEST_ROLE).map(label).join(" | ") || "-";
  const guests = links.filter((l) => l.role === GUEST_ROLE).map(label).join(" | ") || "-";
  const intro = guestIntro ? `${guestIntro} ("${GUEST_INTRO_LABELS[guestIntro as GuestIntro]?.en ?? guestIntro}")` : "default";
  return `main: ${main} / intro: ${intro} / guests: ${guests}`;
}

export function formatReport(plans: Plan[], skippedRows: number): string {
  const out: string[] = [];
  const count = (s: Plan["status"]) => plans.filter((p) => p.status === s).length;
  for (const p of plans.filter((x) => x.status === "change")) {
    if (p.status !== "change") continue;
    out.push(`CHANGE  #${p.event.id} ${p.event.eventCode}  (matched by ${p.matchedBy})`);
    out.push(`  now:  ${describe(p.current.links, p.current.guestIntro)}`);
    out.push(`  new:  ${describe(p.proposed.links, p.proposed.guestIntro)}`);
  }
  for (const p of plans.filter((x) => x.status === "unchanged")) {
    if (p.status === "unchanged") out.push(`SAME    #${p.event.id} ${p.event.eventCode}`);
  }
  for (const p of plans.filter((x) => x.status === "unmatched")) {
    if (p.status === "unmatched") out.push(`SKIP    #${p.event.id} ${p.event.eventCode}: ${p.problems.join("; ")}`);
  }
  for (const p of plans.filter((x) => x.status === "no-event")) {
    if (p.status !== "no-event") continue;
    const why = p.ambiguous.length > 1 ? `several events have this code (${p.ambiguous.join(", ")})` : "no event with this Wix ID or code";
    out.push(`NOEVENT ${p.row.eventCode || "(no code)"} [${p.row.wixId}]: ${why}`);
  }
  out.push("");
  out.push(
    `Wix rows with a guest or intro: ${plans.length} (rows without: ${skippedRows}) — ` +
      `change ${count("change")}, unchanged ${count("unchanged")}, ` +
      `skipped for unmatched names/phrase ${count("unmatched")}, no event ${count("no-event")}.`,
  );
  out.push(`"~" = teacher matched on a partial name: check it. "(kept)" = linked today, not listed in Wix.`);
  return out.join("\n");
}

/** How every distinct Wix name resolves against the teachers table, whatever the event. */
export function formatNameMatches(rows: WixGuestRow[], teachers: RefTeacher[]): string {
  const names = [...new Set(rows.flatMap((r) => [...r.mainNames, ...r.guestNames]))].sort();
  return names
    .map((name) => {
      const m = matchTeacherName(name, teachers);
      if (m.kind === "exact") return `  =  ${name}`;
      if (m.kind === "partial") return `  ~  ${name} → ${m.teacher.name}`;
      if (m.kind === "ambiguous") return `  ?  ${name} → ${m.candidates.map((c) => c.name).join(" or ")}`;
      return `  ✗  ${name} (no teacher)`;
    })
    .join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const csvIndex = args.indexOf("--csv");
  const csvPath =
    csvIndex >= 0 && args[csvIndex + 1]
      ? path.resolve(args[csvIndex + 1]!)
      : path.resolve(import.meta.dir, "../../../wix-export-20250821.csv");

  const csvText = readFileSync(csvPath, "utf-8");
  const totalRows = (parse(csvText.replace(/^﻿/, ""), { columns: true, skip_empty_lines: true, relax_column_count: true }) as unknown[]).length;
  const rows = parseWixGuestRows(csvText);

  // Loaded here so the pure functions above can be tested without a database.
  const { db } = await import("../db/index.ts");
  const { events, eventTeachers } = await import("../db/schema/retreats.ts");
  const { teachers } = await import("../db/schema/teachers.ts");
  const { eq } = await import("drizzle-orm");
  const { bumpVersion } = await import("../services/sync-versions.ts");

  const teacherRows = await db
    .select({ id: teachers.id, name: teachers.name, abbreviation: teachers.abbreviation, aliases: teachers.aliases })
    .from(teachers);
  const eventRows = (await db.query.events.findMany({
    columns: { id: true, eventCode: true, wixId: true, guestIntro: true },
    with: { eventTeachers: { columns: { teacherId: true, role: true, position: true }, with: { teacher: { columns: { name: true } } } } },
  })) as CandidateEvent[];

  const plans = rows.map((row) => planRow(row, eventRows, teacherRows));
  console.log(`CSV: ${csvPath}`);
  console.log(`Events in database: ${eventRows.length}, teachers: ${teacherRows.length}`);
  console.log("\nWix names (= exact, ~ partial, ? ambiguous, ✗ none):");
  console.log(formatNameMatches(rows, teacherRows));
  console.log("");
  console.log(formatReport(plans, totalRows - rows.length));

  const changes = plans.filter(
    (p): p is Extract<Plan, { proposed: unknown }> => p.status === "change",
  );
  if (!apply) {
    console.log(`\nDry run: nothing written. Re-run with --apply to write the ${changes.length} change(s).`);
    process.exit(0);
  }
  for (const p of changes) {
    await db.transaction(async (tx) => {
      await tx.delete(eventTeachers).where(eq(eventTeachers.eventId, p.event.id));
      if (p.proposed.links.length > 0) {
        await tx.insert(eventTeachers).values(
          p.proposed.links.map((l, position) => ({ eventId: p.event.id, teacherId: l.teacherId, role: l.role, position })),
        );
      }
      await tx
        .update(events)
        .set({ guestIntro: p.proposed.guestIntro, updatedAt: new Date() })
        .where(eq(events.id, p.event.id));
    });
  }
  if (changes.length > 0) await bumpVersion("events");
  console.log(`\nApplied ${changes.length} change(s).`);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
