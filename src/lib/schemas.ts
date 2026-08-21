import { z } from "zod";

// Auth
export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export const requestMagicLinkSchema = z.object({
  email: z.email(),
  device_fingerprint: z.string().min(1),
  device_name: z.string().min(1),
  device_type: z.string().min(1),
  language: z.enum(["en", "pt"]).optional().default("en"),
});

export const discoverDeviceSchema = z.object({
  device_fingerprint: z.string().min(1),
});

export const requestApprovalSchema = z.object({
  email: z.email(),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  message: z.string().optional(),
  device_fingerprint: z.string().min(1),
  device_name: z.string().min(1),
  device_type: z.string().min(1),
  language: z.enum(["en", "pt"]).optional().default("en"),
});

export const autoActivateSchema = z.object({
  token: z.string().min(1),
  device_fingerprint: z.string().min(1),
  device_name: z.string().min(1),
  device_type: z.string().min(1),
});

export const deactivateDeviceSchema = z.object({
  device_fingerprint: z.string().min(1),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

// Teachers
export const createTeacherSchema = z.object({
  name: z.string().min(1).max(200),
  abbreviation: z.string().min(1).max(50),
  aliases: z.array(z.string().max(20)).optional().default([]),
  photoUrl: z.string().url().optional().nullable(),
  avatarS3Key: z.string().optional().nullable(),
  heroS3Key: z.string().optional().nullable(),
  heroFocalX: z.number().int().min(0).max(100).optional(),
  heroFocalY: z.number().int().min(0).max(100).optional(),
  heroScale: z.number().int().min(50).max(300).optional(),
});

export const updateTeacherSchema = createTeacherSchema.partial();

// Places
export const createPlaceSchema = z.object({
  name: z.string().min(1).max(200),
  abbreviation: z.string().max(50).optional().nullable(),
  location: z.string().optional().nullable(),
});

export const updatePlaceSchema = createPlaceSchema.partial();

// Retreat Groups
export const createRetreatGroupSchema = z.object({
  nameEn: z.string().min(1).max(200),
  namePt: z.string().max(200).optional().nullable(),
  abbreviation: z.string().max(10).optional().nullable(),
  slug: z.string().min(1).max(100),
  description: z.string().optional().nullable(),
  logoUrl: z.string().url().optional().nullable(),
  avatarS3Key: z.string().optional().nullable(),
  heroS3Key: z.string().optional().nullable(),
  heroFocalX: z.number().int().min(0).max(100).optional(),
  heroFocalY: z.number().int().min(0).max(100).optional(),
  heroScale: z.number().int().min(50).max(300).optional(),
  displayOrder: z.number().int().min(0).optional().default(0),
});

export const updateRetreatGroupSchema = createRetreatGroupSchema.partial();

// Event Types
export const createEventTypeSchema = z.object({
  nameEn: z.string().min(1).max(200),
  namePt: z.string().max(200).optional().nullable(),
  abbreviation: z.string().min(1).max(20),
  slug: z.string().min(1).max(100),
  displayOrder: z.number().int().min(0).optional().default(0),
});

export const updateEventTypeSchema = createEventTypeSchema.partial();

// Audiences
export const createAudienceSchema = z.object({
  nameEn: z.string().min(1).max(200),
  namePt: z.string().max(200).optional().nullable(),
  slug: z.string().min(1).max(100),
  displayOrder: z.number().int().min(0).optional().default(0),
});

export const updateAudienceSchema = createAudienceSchema.partial();

// Publications
export const createPublicationSchema = z.object({
  title: z.string().min(1).max(300),
  subtitle: z.string().max(300).optional().nullable(),
  description: z.string().optional().nullable(),
  authors: z.array(z.string().max(200)).optional().default([]),
  language: z.string().min(2).max(10).optional().default("pt"),
  version: z.string().max(50).optional().nullable(),
  publicationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  coverImageS3Key: z.string().optional().nullable(),
  pdfS3Key: z.string().min(1),
  fileSizeBytes: z.number().int().min(0).optional().nullable(),
  pageCount: z.number().int().min(0).optional().nullable(),
  accessLevel: z.enum(["public", "subscribers"]).optional().default("public"),
});

export const updatePublicationSchema = createPublicationSchema.partial();

// Events (formerly Retreats)
export const createEventSchema = z.object({
  eventCode: z.string().min(1).max(100),
  titleEn: z.string().min(1).max(200),
  titlePt: z.string().max(200).optional().nullable(),
  mainThemesPt: z.string().optional().nullable(),
  mainThemesEn: z.string().optional().nullable(),
  sessionThemesEn: z.string().optional().nullable(),
  sessionThemesPt: z.string().optional().nullable(),
  titleEnReviewed: z.boolean().optional(),
  titlePtReviewed: z.boolean().optional(),
  mainThemesEnReviewed: z.boolean().optional(),
  mainThemesPtReviewed: z.boolean().optional(),
  sessionThemesEnReviewed: z.boolean().optional(),
  sessionThemesPtReviewed: z.boolean().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  eventTypeId: z.number().int().optional().nullable(),
  audienceId: z.number().int().optional().nullable(),
  bibliography: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  status: z.enum(["draft", "published", "archived"]).optional().default("draft"),
  imageUrl: z.string().url().optional().nullable(),
  featuredAt: z.string().datetime().optional().nullable(),
  teacherIds: z.array(z.object({
    id: z.number().int(),
    role: z.enum(["teacher", "guest", "translator"]).optional().default("teacher"),
  })).optional().default([]),
  groupIds: z.array(z.number().int()).optional().default([]),
  placeIds: z.array(z.number().int()).optional().default([]),
  publicationIds: z.array(z.number().int()).optional().default([]),
});

export const updateEventSchema = createEventSchema.partial();

// Sessions
export const createSessionSchema = z.object({
  eventId: z.number().int(),
  titleEn: z.string().max(200).optional().nullable(),
  titlePt: z.string().max(200).optional().nullable(),
  titleEnReviewed: z.boolean().optional(),
  titlePtReviewed: z.boolean().optional(),
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  timePeriod: z.enum(["morning", "afternoon", "evening", "full_day"]).optional().nullable(),
  sessionNumber: z.number().int().min(1),
  description: z.string().optional().nullable(),
});

export const updateSessionSchema = createSessionSchema.partial();

// Event videos — one row per Bunny Stream recording attached to an event.
export const createEventVideoSchema = z.object({
  eventId: z.number().int(),
  bunnyVideoId: z.string().min(1),
  position: z.number().int().min(0).optional().default(0),
  titleEn: z.string().max(200).optional().nullable(),
  titlePt: z.string().max(200).optional().nullable(),
  videoDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

export const updateEventVideoSchema = z.object({
  position: z.number().int().min(0).optional(),
  titleEn: z.string().max(200).optional().nullable(),
  titlePt: z.string().max(200).optional().nullable(),
  videoDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  hasBurnedSlides: z.boolean().optional(),
  masterS3Key: z.string().optional().nullable(),
});

// Video title slides — admin-authored intro/outro title-card document,
// stored as JSONB on event_videos.slides and rendered by the shared
// renderer in src/lib/slides/render.ts (both the admin preview and the
// burn container use it, so preview and burn can never drift). This
// mirrors the SlideDocument/Slide/Line/Span shape in src/lib/slides/types.ts
// exactly — the bounds below exist only to keep a malformed payload from
// becoming an unrenderable or runaway-length burned video, not to add new
// product rules.
const slideSpanSchema = z.object({
  text: z.string().max(300),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
});

const slideLineSizeSchema = z.enum(["sm", "md", "lg", "xl"]);

const slideTextLineSchema = z.object({
  id: z.string().min(1),
  type: z.literal("text"),
  spans: z.array(slideSpanSchema),
  size: slideLineSizeSchema,
  dim: z.boolean().optional(),
});

const slideImageLineSchema = z.object({
  id: z.string().min(1),
  type: z.literal("image"),
  s3Key: z.string().min(1),
  alt: z.string().optional(),
});

const slideSpacerLineSchema = z.object({
  id: z.string().min(1),
  type: z.literal("spacer"),
});

const slideLineSchema = z.discriminatedUnion("type", [
  slideTextLineSchema,
  slideImageLineSchema,
  slideSpacerLineSchema,
]);

const slideSchema = z.object({
  id: z.string().min(1),
  durationMs: z.number().int().min(500).max(30000),
  fadeMs: z.number().int().min(0).max(5000),
  lines: z.array(slideLineSchema).max(12),
});

const slideSequenceSchema = z.array(slideSchema).max(20);

export const slideDocumentSchema = z.object({
  version: z.number().int(),
  intro: slideSequenceSchema,
  outro: slideSequenceSchema,
});

// PUT /admin/videos/:id/slides body.
export const putEventVideoSlidesSchema = z.object({
  slides: slideDocumentSchema,
});

// POST /admin/videos/:id/slides/image-urls body — resolve stored slide-image
// s3Keys to presigned GET URLs for the admin preview. This schema only bounds
// the shape of a well-formed request; the route itself is responsible for
// restricting which keys actually get presigned (see its SECURITY comment).
/**
 * Create a video row from an uploaded master and queue its slide burn-in.
 * `bunnyVideoId` is deliberately absent — it does not exist until the burn
 * completes and the webhook supplies it.
 */
export const burnVideoSchema = z.object({
  eventId: z.number().int().positive(),
  masterS3Key: z.string().min(1).max(512),
  slides: slideDocumentSchema,
  position: z.number().int().min(0).optional(),
  titleEn: z.string().max(200).nullable().optional(),
  titlePt: z.string().max(200).nullable().optional(),
  videoDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

export const slideImageUrlsSchema = z.object({
  s3Keys: z.array(z.string().min(1).max(512)).max(40),
});

// Import a video by URL (Google Drive share link or any public direct URL).
// `slides` is optional — when supplied, the route hands the URL to the burn
// container (MASTER_SOURCE_URL) instead of importing straight to Bunny; see
// POST /admin/videos/import-url.
export const importEventVideoUrlSchema = z.object({
  eventId: z.number().int(),
  url: z.string().min(1).max(2000),
  title: z.string().trim().min(1).max(200).optional(),
  slides: slideDocumentSchema.optional(),
});

// Tracks (audio only — video lives on the parent event)
export const createTrackSchema = z.object({
  sessionId: z.number().int(),
  title: z.string().min(1).max(200),
  titleEn: z.string().max(200).optional().nullable(),
  titlePt: z.string().max(200).optional().nullable(),
  titleEnReviewed: z.boolean().optional(),
  titlePtReviewed: z.boolean().optional(),
  trackNumber: z.number().int().min(1),
  languages: z.array(z.string().min(2).max(10)).optional().default(["en"]),
  originalLanguage: z.string().min(2).max(10).optional().default("en"),
  isTranslation: z.boolean().optional().default(false),
  isPractice: z.boolean().optional().default(false),
  originalTrackId: z.number().int().optional().nullable(),
  s3Key: z.string().optional().nullable(),
  durationSeconds: z.number().int().min(0).optional().default(0),
  fileSizeBytes: z.number().int().min(0).optional().nullable(),
  originalFilename: z.string().optional().nullable(),
  speaker: z.string().max(10).optional().nullable(),
});

export const updateTrackSchema = z.object({
  sessionId: z.number().int(),
  title: z.string().min(1).max(200),
  titleEn: z.string().max(200).nullable(),
  titlePt: z.string().max(200).nullable(),
  titleEnReviewed: z.boolean(),
  titlePtReviewed: z.boolean(),
  trackNumber: z.number().int().min(1),
  languages: z.array(z.string().min(2).max(10)),
  originalLanguage: z.string().min(2).max(10),
  isTranslation: z.boolean(),
  isPractice: z.boolean(),
  originalTrackId: z.number().int().nullable(),
  s3Key: z.string().nullable(),
  durationSeconds: z.number().int().min(0),
  fileSizeBytes: z.number().int().min(0).nullable(),
  originalFilename: z.string().nullable(),
  speaker: z.string().max(10).nullable(),
}).partial();

// User content
export const updateProgressSchema = z.object({
  trackId: z.number().int(),
  positionSeconds: z.number().int().min(0),
  durationSeconds: z.number().int().min(1).optional(),
});

export const createBookmarkSchema = z.object({
  trackId: z.number().int(),
  positionSeconds: z.number().int().min(0),
  title: z.string().max(200).optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const createEventBookmarkSchema = z.object({
  eventId: z.number().int(),
});

export const createTrackBookmarkSchema = z.object({
  trackId: z.number().int(),
});

/**
 * Safe filename: allows letters (including accented), digits, spaces, hyphens,
 * underscores, dots, parentheses, brackets, and plus signs — but explicitly
 * forbids path traversal sequences (`..`), directory separators (`/`, `\`),
 * control characters (0x00–0x1f), and leading dots.
 *
 * Examples that PASS: "001 JKR - The practice (17 April AM).mp3"
 *                     "02_KPS [TIB] Prayers 2017-11-14.mp3"
 *                     "Transcript Réunion été.pdf"
 * Examples that FAIL: "../../etc/passwd", "/etc/passwd", ".hidden", "evil\file"
 */
const safeFilenameSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(
    /^[^/\\].*$/,
    "Filename must not start with a path separator",
  )
  .refine(
    (v) => !v.includes(".."),
    "Filename must not contain path traversal sequences (..)",
  )
  .refine(
    (v) => !v.includes("/"),
    "Filename must not contain forward slashes",
  )
  .refine(
    (v) => !v.includes("\\"),
    "Filename must not contain backslashes",
  )
  .refine(
    // eslint-disable-next-line no-control-regex
    (v) => !/[\x00-\x1f]/.test(v),
    "Filename must not contain control characters",
  )
  .refine(
    (v) => !v.startsWith("."),
    "Filename must not start with a dot",
  );

// Upload
export const presignUploadSchema = z.object({
  files: z.array(z.object({
    filename: safeFilenameSchema,
    contentType: z.string().min(1),
    size: z.number().int().min(1),
  })),
  eventCode: z.string().min(1),
  sessionNumber: z.number().int().min(1),
});

export const presignTranscriptSchema = z.object({
  eventCode: z.string().min(1).max(200),
  filename: safeFilenameSchema,
  contentType: z.string().min(1).max(200),
});

const eventFileTypeSchema = z.enum([
  "image",
  "document",
  "other",
  "subtitle",
  "design",
]);

// Presign upload for a generic event document.
export const presignFileSchema = z.object({
  eventCode: z.string().min(1).max(200),
  filename: safeFilenameSchema,
  contentType: z.string().min(1).max(200),
  fileType: eventFileTypeSchema,
});

// Presign upload for a video master recording (pre-burn source file), so the
// browser can PUT it straight to S3 instead of routing multi-GB files
// through Bunny's TUS endpoint. See services/bunny.ts buildTusCredentials
// for the equivalent flow when slides are skipped.
export const presignVideoMasterSchema = z.object({
  eventCode: z.string().min(1).max(200),
  filename: safeFilenameSchema,
  contentType: z.string().min(1).max(200),
});

// Persist an event_files row after the S3 PUT completes.
export const createEventFileSchema = z.object({
  eventId: z.number().int(),
  originalFilename: z.string().min(1).max(500),
  s3Key: z.string().min(1).max(1000),
  fileType: eventFileTypeSchema,
  extension: z.string().min(1).max(20),
  fileSizeBytes: z.number().int().min(0).optional().nullable(),
  language: z.string().max(20).optional().nullable(),
  title: z.string().max(300).optional().nullable(),
  sensitive: z.boolean().optional().default(false),
  sortOrder: z.number().int().min(0).optional().default(0),
});

export const updateEventFileSchema = z.object({
  title: z.string().max(300).optional().nullable(),
  sensitive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  language: z.string().max(20).optional().nullable(),
  fileType: eventFileTypeSchema.optional(),
});

// Persist a transcripts row from the admin (fixes the persistence gap).
export const createTranscriptSchema = z.object({
  eventId: z.number().int(),
  language: z.string().min(1).max(20),
  s3Key: z.string().min(1).max(1000),
  originalFilename: z.string().max(500).optional().nullable(),
  fileSizeBytes: z.number().int().min(0).optional().nullable(),
  pageCount: z.number().int().min(0).optional().nullable(),
  status: z.string().max(20).optional().default("published"),
});

export const updateTranscriptSchema = z.object({
  language: z.string().min(1).max(20).optional(),
  status: z.string().max(20).optional(),
});

// AI assist (event + sessions + tracks)
const aiEventFieldsSchema = z.object({
  titleEn: z.string().max(500).optional(),
  titlePt: z.string().max(500).optional(),
  mainThemesEn: z.string().max(5000).optional(),
  mainThemesPt: z.string().max(5000).optional(),
  sessionThemesEn: z.string().max(5000).optional(),
  sessionThemesPt: z.string().max(5000).optional(),
  startDate: z.string().max(20).optional(),
  endDate: z.string().max(20).optional(),
});

export const aiAssistSchema = z.object({
  instruction: z.string().min(1).max(2000),
  event: aiEventFieldsSchema.optional(),
  sessions: z
    .array(
      z.object({
        rowKey: z.string().min(1).max(100),
        // The number the admin shows this session under, so an instruction
        // can name it ("session 3") instead of quoting its title.
        sessionNumber: z.number().int().min(0).max(10000).optional(),
        titleEn: z.string().max(500).optional(),
        titlePt: z.string().max(500).optional(),
      }),
    )
    .max(500)
    .optional(),
  // Event videos (`event_videos` rows) — a separate entity from the audio
  // tracks, so an instruction about videos needs them in the payload or the
  // model has nothing to act on.
  videos: z
    .array(
      z.object({
        rowKey: z.string().min(1).max(100),
        // 1-based, as the admin labels it ("Video 2").
        videoNumber: z.number().int().min(0).max(10000).optional(),
        title: z.string().max(500),
        titleEn: z.string().max(500).optional(),
        titlePt: z.string().max(500).optional(),
        videoDate: z.string().max(20).optional(),
      }),
    )
    .max(500)
    .optional(),
  // Legacy retreat imports routinely carry several hundred tracks (one event
  // in production has 342), so these caps only exist to bound a runaway
  // payload — aiAssistEvent batches the list across Claude calls rather than
  // relying on a cap small enough to fit one reply. An empty list is valid on
  // its own: a video-only event has no tracks to send.
  tracks: z
    .array(
      z.object({
        rowKey: z.string().min(1).max(100),
        // Where the track sits in the admin: which session, and its number
        // within that session. Sent so an instruction can address tracks
        // positionally ("tracks 3 to 7", "the last track of session 2")
        // instead of having to quote titles.
        sessionNumber: z.number().int().min(0).max(10000).optional(),
        trackNumber: z.number().int().min(0).max(10000).optional(),
        originalFilename: z.string().max(500),
        title: z.string().max(500),
        titleEn: z.string().max(500).optional(),
        titlePt: z.string().max(500).optional(),
        speaker: z.string().max(100).optional().nullable(),
        // The track's current spoken languages. Sent as context so an
        // instruction can filter on them ("the Tibetan tracks") and so an
        // unchanged list can be recognized as a no-op; the recognized codes
        // are enforced in ai-assist.ts, which also cleans the reply.
        languages: z.array(z.string().min(2).max(10)).max(10).optional(),
      }),
    )
    .max(5000),
})
  // Any one of the three row lists is enough to work on, but a payload with
  // none of them gives the model nothing to act on — reject it here rather
  // than spending a Claude call to be told so.
  .refine(
    (v) => v.tracks.length > 0 || (v.videos?.length ?? 0) > 0 || (v.sessions?.length ?? 0) > 0,
    { message: "Provide at least one track, video, or session to work on" },
  );

// Pagination
export const paginationSchema = z.object({
  _start: z.coerce.number().int().min(0).optional().default(0),
  _end: z.coerce.number().int().min(1).optional().default(25),
  _sort: z.string().optional().default("id"),
  _order: z.enum(["ASC", "DESC"]).optional().default("ASC"),
});

// User management
export const updateUserSchema = z.object({
  firstName: z.string().max(100).optional().nullable(),
  lastName: z.string().max(100).optional().nullable(),
  dharmaName: z.string().max(100).optional().nullable(),
  preferredLanguage: z.enum(["en", "pt"]).optional(),
  role: z.enum(["user", "admin", "superadmin"]).optional(),
  isActive: z.boolean().optional(),
  subscriptionStatus: z.enum(["active", "expired", "none"]).optional(),
  subscriptionSource: z
    .enum(["easypay", "cash", "admin", "bank_transfer"])
    .optional()
    .nullable(),
  subscriptionExpiresAt: z.string().optional().nullable(),
  subscriptionNotes: z.string().max(500).optional().nullable(),
});
