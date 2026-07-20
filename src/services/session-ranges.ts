/**
 * Range-based session inference.
 *
 * Some legacy events encode their session structure only in the Portuguese
 * translation filenames, as track ranges:
 *
 *   001-037 [TRAD] 6_10 - Manha.mp3   → tracks 1..37, 6 October, morning
 *
 * The individual Tibetan/English tracks carry no session marker at all, so
 * they can only be placed by number. This module turns those ranges into
 * sessions and assigns every other track to the range containing it.
 *
 * Reached only when at least one file carries an explicit range, which is what
 * keeps every other event's grouping unchanged.
 */
import type { ParsedTrack, InferredSession } from "./track-parser.ts";
import type { AnalysisNote } from "./track-conventions.ts";
import { extractBareSessionDate } from "./session-dates.ts";

interface Definer {
  start: number;
  end: number;
  date: string | null;
  timePeriod: string | null;
  descriptor: string | null;
  tracks: ParsedTrack[];
}

/** True when at least one track carries an explicit "NNN-NNN" range. */
export function hasTrackRanges(tracks: ParsedTrack[]): boolean {
  return tracks.some((t) => t.trackRange !== null);
}

export function inferSessionsFromRanges(
  tracks: ParsedTrack[],
): { sessions: InferredSession[]; notes: AnalysisNote[] } {
  const notes: AnalysisNote[] = [];
  const ranged = tracks.filter((t) => t.trackRange !== null);
  const others = tracks.filter((t) => t.trackRange === null);

  const inExplicitRange = (n: number): boolean =>
    ranged.some((t) => n >= t.trackRange!.start && n <= t.trackRange!.end);

  // Keyed WITHOUT part number, so "Parte 1"/"Parte 2" of one range collapse
  // into a single session instead of splitting it.
  const definers = new Map<string, Definer>();
  const addDefiner = (
    track: ParsedTrack,
    start: number,
    end: number,
    date: string | null,
    timePeriod: string | null,
    descriptor: string | null,
  ): void => {
    const key = `${start}-${end}|${date ?? ""}|${timePeriod ?? ""}`;
    const existing = definers.get(key);
    if (existing) {
      existing.tracks.push(track);
      return;
    }
    definers.set(key, { start, end, date, timePeriod, descriptor, tracks: [track] });
  };

  for (const t of ranged) {
    addDefiner(t, t.trackRange!.start, t.trackRange!.end, t.date, t.timePeriod, null);
  }

  // A dated track sitting outside every explicit range defines its own
  // single-track session, e.g. "093 [TRAD] - 7_10 - Questao extra".
  const plain: ParsedTrack[] = [];
  for (const t of others) {
    if (t.trackNumber > 0 && !inExplicitRange(t.trackNumber)) {
      const bare = extractBareSessionDate(t.originalFilename);
      if (bare) {
        addDefiner(t, t.trackNumber, t.trackNumber, bare.date, null, bare.descriptor || null);
        continue;
      }
    }
    plain.push(t);
  }

  const defs = [...definers.values()];

  for (let i = 0; i < defs.length; i++) {
    for (let j = i + 1; j < defs.length; j++) {
      const a = defs[i]!;
      const b = defs[j]!;
      const overlaps = a.start <= b.end && b.start <= a.end;
      const identical = a.start === b.start && a.end === b.end;
      if (overlaps && !identical) {
        notes.push({
          severity: "warning",
          message:
            `Track ranges ${a.start}-${a.end} and ${b.start}-${b.end} overlap. `
            + `Tracks in the overlap were assigned to the narrower range.`,
          relatedFilename: undefined,
        });
      }
    }
  }

  const assigned = new Map<Definer, ParsedTrack[]>(defs.map((d) => [d, []]));
  const uncovered: ParsedTrack[] = [];
  for (const t of plain) {
    const candidates = defs.filter((d) => t.trackNumber >= d.start && t.trackNumber <= d.end);
    if (candidates.length === 0) {
      uncovered.push(t);
      continue;
    }
    candidates.sort((a, b) => a.end - a.start - (b.end - b.start));
    assigned.get(candidates[0]!)!.push(t);
  }

  if (uncovered.length > 0) {
    notes.push({
      severity: "warning",
      message:
        `${uncovered.length} track(s) fall outside every track range and were placed in an `
        + `"Unassigned tracks" session: ${uncovered.map((t) => t.originalFilename).join(", ")}`,
      relatedFilename: undefined,
    });
  }

  for (const d of defs) {
    if (assigned.get(d)!.length === 0) {
      notes.push({
        severity: "info",
        message:
          `Range ${d.start}-${d.end} matched no individual tracks; its session contains `
          + `only the grouped recording.`,
        relatedFilename: undefined,
      });
    }
  }

  defs.sort((a, b) => a.start - b.start || a.end - b.end);

  const sessions: InferredSession[] = [];
  let sessionNumber = 1;
  for (const d of defs) {
    const definerTracks = [...d.tracks].sort(
      (a, b) => (a.partNumber ?? 0) - (b.partNumber ?? 0),
    );
    const members = [...assigned.get(d)!].sort((a, b) => a.trackNumber - b.trackNumber);
    sessions.push({
      sessionNumber,
      date: d.date,
      timePeriod: d.timePeriod,
      partNumber: null,
      titleEn: buildTitle(d, sessionNumber),
      tracks: [...members, ...definerTracks],
    });
    sessionNumber++;
  }

  if (uncovered.length > 0) {
    sessions.push({
      sessionNumber,
      date: null,
      timePeriod: null,
      partNumber: null,
      titleEn: "Unassigned tracks",
      tracks: [...uncovered].sort((a, b) => a.trackNumber - b.trackNumber),
    });
  }

  return { sessions, notes };
}

function buildTitle(d: Definer, sessionNumber: number): string {
  const periodLabel =
    d.timePeriod === "morning" ? "Morning"
    : d.timePeriod === "afternoon" ? "Afternoon"
    : d.timePeriod === "evening" ? "Evening"
    : null;
  const suffix = periodLabel ?? d.descriptor;
  if (d.date && suffix) return `${d.date} - ${suffix}`;
  if (d.date) return d.date;
  if (suffix) return suffix;
  return `Session ${sessionNumber}`;
}
