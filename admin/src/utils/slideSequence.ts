/**
 * Pure helpers behind the slide editor's sequence column, header and the
 * add-video dialog. No React, no network: durations, labels, session labels
 * and the filename to session match.
 */

import { lineText, slideTotalMs, type Slide, type SlideDocument, type SlideRole } from "@slides/types.ts";
import { parseTrackFile, toIsoSessionDate } from "./trackParser";

/** The session fields the editor needs, whatever the caller's row type. */
export interface SessionOption {
  id: number;
  sessionNumber: number;
  /** ISO "YYYY-MM-DD" (or a display date from older rows). */
  date: string | null;
  timePeriod: string | null;
}

/** m:ss, rounded to whole seconds. 38 400 ms gives "0:38", 84 000 ms gives "1:24". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "5.6 s": one decimal, trailing ".0" kept so a column of values lines up. */
export function formatSecondsLabel(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Total length of a sequence in ms, fades included; the logo clip counts as its own length. */
export function sequenceDurationMs(slides: Slide[]): number {
  return slides.reduce((sum, s) => sum + slideTotalMs(s), 0);
}

export function documentDurationMs(doc: SlideDocument): number {
  return sequenceDurationMs(doc.intro) + sequenceDurationMs(doc.outro);
}

const ROLE_FALLBACK_LABEL: Record<SlideRole, string> = {
  logo: "Logo",
  speaker: "Speaker",
  title: "Title",
  "date-place": "Date and place",
  session: "Session",
  credits: "Credits",
};

/**
 * What a slide is called in the sequence column: its role name when the
 * generator set one, otherwise its first non-empty text, otherwise a
 * placeholder ("Image" for a picture-only slide, "Empty slide").
 */
export function slideLabel(slide: Slide, roleName: (role: SlideRole) => string = (r) => ROLE_FALLBACK_LABEL[r]): string {
  if (slide.role) return roleName(slide.role);
  for (const line of slide.lines) {
    const text = lineText(line).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  if (slide.lines.some((l) => l.type === "image")) return "Image";
  return "Empty slide";
}

const PERIOD_LABELS: Record<string, string> = { morning: "Morning", afternoon: "Afternoon", evening: "Evening" };

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-10" gives "10 Oct 2026"; anything else is returned as is. */
export function formatShortDate(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const month = m ? MONTHS_SHORT[Number(m[2]) - 1] : undefined;
  if (!m || !month) return iso;
  return `${Number(m[3])} ${month} ${m[1]}`;
}

/** Sessions in event order, which is what "Session N of M" counts. */
export function orderedSessions<T extends SessionOption>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => a.sessionNumber - b.sessionNumber);
}

/** "Session 1 · 10 Oct 2026 · Morning". N is the position in the event, like the slide. */
export function sessionLabel(session: SessionOption, sessions: SessionOption[]): string {
  const index = orderedSessions(sessions).findIndex((s) => s.id === session.id);
  const parts = [
    `Session ${index >= 0 ? index + 1 : session.sessionNumber}`,
    formatShortDate(toIso(session.date)),
    session.timePeriod ? (PERIOD_LABELS[session.timePeriod] ?? session.timePeriod) : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function toIso(date: string | null): string | null {
  if (!date) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return toIsoSessionDate(date, null);
}

/** Period words a file name can end with, mapped to the session periods they can mean. */
const TRAILING_PERIOD: Record<string, string[]> = {
  am: ["morning"],
  pm: ["afternoon", "evening"],
  morning: ["morning"],
  manha: ["morning"],
  "manhã": ["morning"],
  afternoon: ["afternoon"],
  tarde: ["afternoon"],
  evening: ["evening"],
  noite: ["evening"],
};

/**
 * The session a file name points at ("JKR-Lx-2026-10-10-AM.mp4"): the one
 * session with that date and period. The date comes from the track parser; its
 * AM/PM marker only recognises "(10 October AM)" shapes, so a trailing
 * "-AM" or "-Evening" is read here. PM fits an afternoon or an evening session.
 * Null when the name has no date or period, or when zero or several sessions
 * fit, so a guess is never pre-selected.
 */
export function matchSessionFromFilename(filename: string, sessions: SessionOption[]): SessionOption | null {
  const parsed = parseTrackFile(new File([], filename));
  // A full ISO date in the name wins: the parser may read "10-10-AM" as a day
  // and month without a year.
  const wanted = /(\d{4}-\d{2}-\d{2})/.exec(filename)?.[1] ?? toIso(parsed.date);
  if (!wanted) return null;

  let periods: string[] | undefined = parsed.timePeriod
    ? parsed.timePeriod === "afternoon"
      ? ["afternoon", "evening"]
      : [parsed.timePeriod]
    : undefined;
  if (!periods) {
    const trailing = /[\s_.-]([A-Za-zãÃ]+)$/.exec(filename.replace(/\.[^.]+$/, ""));
    periods = trailing ? TRAILING_PERIOD[trailing[1]!.toLowerCase()] : undefined;
  }
  if (!periods) return null;

  const matches = sessions.filter(
    (s) => s.timePeriod !== null && periods.includes(s.timePeriod) && toIso(s.date) === wanted,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** The video's own date as the session fallback: the single session on that date. */
export function matchSessionFromDate(date: string | null, sessions: SessionOption[]): SessionOption | null {
  if (!date) return null;
  const matches = sessions.filter((s) => toIso(s.date) === date);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** The fields of an event video that decide how its row reads. */
export interface VideoFileState {
  bunnyVideoId: string | null;
  masterS3Key?: string | null;
  hasBurnedSlides?: boolean;
  burnStatus?: string | null;
  slides?: SlideDocument | null;
}

/** Slides exist, no file has been uploaded yet: "Slides ready, video not uploaded". */
export function isAwaitingFile(video: VideoFileState): boolean {
  const hasSlides = !!video.slides && (video.slides.intro.length > 0 || video.slides.outro.length > 0);
  return (
    hasSlides &&
    !video.bunnyVideoId &&
    !video.masterS3Key &&
    !video.hasBurnedSlides &&
    (video.burnStatus ?? "none") === "none"
  );
}

/** Which of the dashed Video block's states the sequence column shows. */
export type VideoBlockState = "notUploaded" | "uploaded" | "burn";

export function videoBlockState(video: { hasFile: boolean; burnStatus: string | null }): VideoBlockState {
  const status = video.burnStatus ?? "none";
  if (!video.hasFile) return "notUploaded";
  if (status === "queued" || status === "running" || status === "failed") return "burn";
  return "uploaded";
}
