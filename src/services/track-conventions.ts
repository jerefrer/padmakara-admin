import { z } from "zod";

export const FOLDER_NAME_CONVENTION = `
The folder name (when present) loosely encodes the event: a date
(YYYY.MM.DD, range allowed), a teacher abbreviation, a place abbreviation,
sometimes an event-type code, and — only for parallel-retreat series — a
group code. Separators vary (spaces, hyphens, dots).

- Match the teacher, place, and (only if clearly present) group against the
  lists you receive in the user message, and return their ids.
- Event-type codes — CFR, ENS, ERT, LNG, RET, CONF — are event TYPES, not
  places or groups. They are detected automatically; never treat one as an
  unknown place/group and never warn about it.
- A group is OPTIONAL and most events have none. Do NOT warn about a missing
  or unmatched group.
- The date and the event type are detected deterministically elsewhere — do
  NOT flag anything about the folder's format, separators, or those fields.
- The folder name may be empty (loose files dropped without a folder). That is
  fine — infer what you can from the track filenames instead.
`.trim();

export const FILENAME_CONVENTION = `
Filenames are written by a human and are meant to stay human-readable.
They typically look like: "001 JKR - The meaning of Shamatha.mp3".

Leave them as-is. Do NOT reformat them. Specifically:
- Do NOT convert spaces to underscores.
- Do NOT change capitalization.
- Keep the existing track-number style (e.g. three-digit "001" stays "001").
- Audio extensions only: .mp3 .m4a .wav .flac .ogg
`.trim();

export const WRITING_RULES = `
Be PROACTIVE about fixing genuine mistakes — spelling errors, missing
accents, and stray capitals are almost never intentional, so fix them. Every
change is shown to the admin with a clear before→after, and they can revert
anything that was actually deliberate. What you must NOT do is impose a
stylistic SCHEME the human didn't choose (don't Title-Case everything, don't
reformat filenames).

Track display title (the track's own language — English for JKR tracks,
Portuguese for TRAD tracks; never both):
- Fix spelling typos: "lazyness" → "laziness", "conciousness" →
  "consciousness", "rather then" → "rather than", "lifes" → "lives".
- Add missing Portuguese accents/diacritics: "introducao" → "introdução",
  "respiracao" → "respiração", "pratica" → "prática".
- Fix STRAY capitals that have no obvious reason — a capital letter in the
  middle of a word, or a randomly capitalized word mid-sentence. But do NOT
  impose Title Case: "The meaning of Shamatha" is a fine sentence-style title,
  leave its capitalization as-is.
- Do NOT translate. Do NOT add the speaker, date, or extra words.
- If the title has no genuine error, do not emit an edit for it.

Track filename (this becomes the S3 key):
- ALWAYS apply the same spelling typo fix to the filename when you fix it in
  the title (e.g. title "...consciousness" → filename
  "050 JKR - Question about the eight consciousness.mp3"). A clean title with
  a misspelled filename is wrong — keep them in sync.
- Keep the filename's existing style: spaces stay spaces, capitalization
  stays as the human wrote it. Only the misspelled word(s) change.
- ALWAYS stay ASCII — never introduce accents into a filename. So a
  Portuguese accent fix applies to the DISPLAY TITLE only; the filename keeps
  the ASCII spelling (e.g. title "respiração", filename "...respiracao.mp3").
- Strip leading/trailing spaces around the filename.
- Do NOT convert spaces to underscores.
- If the filename has no genuine error, do not emit an edit for it.

Notes (free-form observations):
- Add a note ONLY when something genuinely needs the admin to DECIDE: a
  filename with no clear track number, a track that could belong to either of
  two sessions, a track date that conflicts with the folder date, an orphan
  file, etc.
- Do NOT write a note for routine, expected things. In particular, NEVER note
  any of these (they are expected and handled automatically):
  - a bilingual pairing, or a language tag ([ENG+POR], [TIB+ENG], [POR], …)
    being stripped from a display title;
  - a missing, absent, or unmatched group;
  - an event-type code (CFR, ENS, ERT, LNG, RET, CONF) appearing in the folder;
  - the folder name's format, separators, or capitalization.
- Do NOT write a note just to explain a spelling/accent fix — the before→after
  diff already shows that.
- Severity: "info" for things worth knowing, "warning" for things the admin
  should review before saving.
`.trim();

// ─── Final result schemas (what the API returns / the frontend consumes) ──

// A correction is COMPUTED server-side by diffing the deterministic value
// against Claude's edit. `field` is the thing that changed; `kind` classifies
// the change so the UI can label it ("Accents added", "Spelling fixed", …).
export const trackCorrectionSchema = z.object({
  field: z.enum(["title", "correctedFilename"]),
  kind: z.enum(["accents", "spelling", "capitalization", "rename"]),
  before: z.string(),
  after: z.string(),
});
export type TrackCorrection = z.infer<typeof trackCorrectionSchema>;

export const noteSchema = z.object({
  severity: z.enum(["info", "warning"]),
  message: z.string(),
  // Claude sometimes sends `null` for "no related filename" rather than
  // omitting the key. Accept both null and absent.
  relatedFilename: z.string().nullish().transform((v) => v ?? undefined),
});
export type AnalysisNote = z.infer<typeof noteSchema>;

export const analysisTrackSchema = z.object({
  position: z.number().int().nonnegative(),
  originalFilename: z.string(),
  // The filename that will be uploaded to S3. Equals originalFilename unless
  // a typo was fixed. ASCII, human-readable, spaces preserved.
  correctedFilename: z.string(),
  // The display title in the track's own language.
  title: z.string(),
  // Language(s) audible in the file, from the deterministic parser. A single
  // file can carry several (e.g. ['tib','en'] for a TIB+ENG recording). Claude
  // never edits these; they flow straight from the parser to the admin form.
  languages: z.array(z.string()).default(["en"]),
  originalLanguage: z.string().default("en"),
  isTranslation: z.boolean().default(false),
  corrections: z.array(trackCorrectionSchema),
});
export type AnalysisTrack = z.infer<typeof analysisTrackSchema>;

export const analysisSessionSchema = z.object({
  sessionNumber: z.number().int().positive(),
  titleEn: z.string(),
  titlePt: z.string(),
  sessionDate: z.string().nullable(),
  timePeriod: z.enum(["morning", "afternoon", "evening"]).nullable(),
  tracks: z.array(analysisTrackSchema),
});
export type AnalysisSession = z.infer<typeof analysisSessionSchema>;

export const aiCoverageSchema = z.object({
  totalTracks: z.number().int().nonnegative(),
  tracksAnalyzedByAi: z.number().int().nonnegative(),
  tracksFromDeterministicFallback: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  chunksFailed: z.number().int().nonnegative(),
});
export type AiCoverage = z.infer<typeof aiCoverageSchema>;

export const analysisEventSchema = z.object({
  titleEn: z.string().nullable(),
  titlePt: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  matchedGroupIds: z.array(z.string()),
  matchedTeacherIds: z.array(z.string()),
  matchedPlaceIds: z.array(z.string()),
  // Event-type id detected deterministically from a code in the folder name
  // (e.g. CFR → Conference). Null when no known type code is present.
  matchedEventTypeId: z.string().nullable().default(null),
  folderConventionOk: z.boolean(),
});
export type AnalysisEvent = z.infer<typeof analysisEventSchema>;

export const analysisResultSchema = z.object({
  aiCoverage: aiCoverageSchema,
  event: analysisEventSchema,
  sessions: z.array(analysisSessionSchema),
  notes: z.array(noteSchema),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

// ─── Delta schema (what Claude returns per chunk) ─────────────────────────
//
// Instead of regenerating the whole structure, Claude only describes what
// should CHANGE relative to the deterministic pre-pass it is shown. Tracks
// that are already correct simply don't appear. This keeps the output tiny
// and removes most of the format-fidelity risk.

// Event metadata Claude infers (first chunk only; null on later chunks).
export const eventDeltaSchema = z
  .object({
    titleEn: z.string().nullish().transform((v) => v ?? null),
    titlePt: z.string().nullish().transform((v) => v ?? null),
    startDate: z.string().nullish().transform((v) => v ?? null),
    endDate: z.string().nullish().transform((v) => v ?? null),
    matchedGroupIds: z.array(z.string()).optional().transform((v) => v ?? []),
    matchedTeacherIds: z.array(z.string()).optional().transform((v) => v ?? []),
    matchedPlaceIds: z.array(z.string()).optional().transform((v) => v ?? []),
  })
  .nullable();
export type EventDelta = z.infer<typeof eventDeltaSchema>;

// A single track the model wants to change. Identified by its original
// filename (the stable key from the deterministic pre-pass). Any field that
// is absent means "leave it unchanged".
export const trackEditSchema = z.object({
  originalFilename: z.string(),
  title: z.string().optional(),
  correctedFilename: z.string().optional(),
});
export type TrackEdit = z.infer<typeof trackEditSchema>;

export const claudeDeltaSchema = z.object({
  event: eventDeltaSchema,
  trackEdits: z.array(trackEditSchema).optional().transform((v) => v ?? []),
  notes: z.array(noteSchema).optional().transform((v) => v ?? []),
});
export type ClaudeDelta = z.infer<typeof claudeDeltaSchema>;
