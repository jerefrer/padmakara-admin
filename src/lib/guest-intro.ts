/**
 * The phrase that introduces an event's guests / other speakers after its main
 * teachers: "Jigme Khyentse Rinpoche & Pema Wangyal Rinpoche — with the presence
 * of Shechen Rabjam Rinpoche". Stored on `retreats.guest_intro` as one of these
 * keys (null = the default rendering, `with_presence_of`); the clients hold the
 * localized labels, so a wording change never needs a migration.
 *
 * The first three come from the old Wix database (`Aux-introGuest`), whose
 * Portuguese wording is kept exactly. The admin (admin/src/i18n) and the app
 * (padmakara-app/locales) carry the same labels as GUEST_INTRO_LABELS below.
 */

export const GUEST_INTRO_KEYS = [
  "with_presence_of",
  "and",
  "practice_sessions_by",
  "with_visit_of",
  "with_guest",
] as const;

export type GuestIntro = (typeof GUEST_INTRO_KEYS)[number];

/** The rendering used when an event has guests but no explicit phrase. */
export const DEFAULT_GUEST_INTRO: GuestIntro = "with_presence_of";

/**
 * Reference labels (also used by the import script's report). `with_guest` in
 * Portuguese is the gender- and number-neutral "com a participação de": "com o
 * convidado" would be wrong for a woman or for several guests.
 */
export const GUEST_INTRO_LABELS: Record<GuestIntro, { en: string; pt: string }> = {
  with_presence_of: { en: "with the presence of", pt: "com a presença de" },
  and: { en: "&", pt: "&" },
  practice_sessions_by: { en: "practice sessions by", pt: "sessões de prática por" },
  with_visit_of: { en: "with the visit of", pt: "com a visita de" },
  with_guest: { en: "with guest", pt: "com a participação de" },
};

export function isGuestIntro(value: unknown): value is GuestIntro {
  return typeof value === "string" && (GUEST_INTRO_KEYS as readonly string[]).includes(value);
}

/**
 * Map a Wix `Aux-introGuest` value to its key. Empty → null (default rendering);
 * a phrase we do not know → undefined, so the caller can report it instead of guessing.
 */
export function guestIntroFromWix(value: string | null | undefined): GuestIntro | null | undefined {
  const v = (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!v) return null;
  for (const key of GUEST_INTRO_KEYS) {
    const { en, pt } = GUEST_INTRO_LABELS[key];
    if (v === pt.toLowerCase() || v === en.toLowerCase()) return key;
  }
  return undefined;
}
