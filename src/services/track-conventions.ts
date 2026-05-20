import { z } from "zod";

export const FOLDER_NAME_CONVENTION = `
Expected folder name format: YYYY.MM.DD[-DD] - GROUP - PLACE - TEACHER
Example: "2025.04.12-13 - PP3 - CCA - JKR"

Rules:
- Date at the start, range allowed with a hyphen for the end day.
- Sections separated by " - " (space-hyphen-space).
- GROUP, PLACE, TEACHER are short uppercase abbreviations matched against
  the lists you receive in the user message.
- Deviations from this format are allowed — flag them in notes if present.
`.trim();

export const FILENAME_CONVENTION = `
Expected filename format: NN_descriptive_title.mp3 (or .m4a, .wav, .flac, .ogg)

Rules:
- Two-digit track number at the start, separated by underscore or hyphen.
- ASCII only — never any accents or diacritics in the filename itself.
- Underscores instead of spaces.
- Common deviations to tolerate (and silently correct): typos, missing
  underscores, mixed case, missing leading zero on track numbers.
`.trim();

export const WRITING_RULES = `
Display titles (event titleEn/titlePt, session titleEn/titlePt, track
displayTitleEn/displayTitlePt):
- Capitalization: Title Case for English, sentence case for Portuguese.
- Accents: PRESENT and correct in Portuguese ("Refúgio", "Introdução",
  "Meditação"). Generally absent in English unless borrowed ("café").
- Fix obvious typos: "introducao" → "Introdução"; "refugio" → "Refúgio".

Corrected filenames (correctedFilename):
- ASCII only — NEVER any accents. If you fix a Portuguese typo on the
  display title, the filename should carry the ASCII-folded form of the
  corrected title (e.g., display "Refúgio" → filename slug "refugio").
- Underscores, not spaces. Two-digit track numbers with leading zero.
- Preserve any existing track numbering from the original filename.
- Audio extensions only: .mp3 .m4a .wav .flac .ogg

Notes (free-form warnings):
- Add a note when: a filename has no clear track number, two tracks could
  belong to either of two sessions, a track date conflicts with the folder
  date, the folder name deviates from FOLDER_NAME_CONVENTION, or anything
  else looks suspicious.
- Severity: "info" for things worth knowing, "warning" for things the
  admin should review.
`.trim();

// ─── Zod schemas ──────────────────────────────────────────────────────

export const trackCorrectionSchema = z.object({
  field: z.enum(["filename", "displayTitleEn", "displayTitlePt"]),
  before: z.string(),
  after: z.string(),
  reason: z.string(),
});
export type TrackCorrection = z.infer<typeof trackCorrectionSchema>;

export const noteSchema = z.object({
  severity: z.enum(["info", "warning"]),
  message: z.string(),
  relatedFilename: z.string().optional(),
});
export type AnalysisNote = z.infer<typeof noteSchema>;

export const analysisTrackSchema = z.object({
  position: z.number().int().nonnegative(),
  originalFilename: z.string(),
  correctedFilename: z.string(),
  displayTitleEn: z.string(),
  displayTitlePt: z.string(),
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

// ─── Per-chunk Claude response schema ─────────────────────────────────
// Claude returns one of these per call. `event` is non-null only for
// the first chunk; null on subsequent chunks of a chunked analysis.

export const claudeChunkResponseSchema = z.object({
  event: analysisEventSchema.nullable(),
  sessions: z.array(analysisSessionSchema),
  notes: z.array(noteSchema),
});
export type ClaudeChunkResponse = z.infer<typeof claudeChunkResponseSchema>;
