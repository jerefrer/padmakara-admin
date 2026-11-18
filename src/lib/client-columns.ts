/**
 * Column lists for the rows that app-facing routes serialize as they come from the
 * database. Storage keys never leave the server: audio, files and videos are served
 * through /api/media (presigned or proxied URLs), so a key would only reveal the
 * bucket layout. Listed explicitly, so a column added later stays server-side until
 * someone decides a client needs it. Admin routes load full rows and do not use these.
 */

/**
 * The event columns app-facing routes load. Content the app shows (titles, themes,
 * bibliography, dates, original language), what the server still needs on the way
 * out (status and the per-section publish switches for the visibility rules, the
 * audience and membership flag for the access check, the sale fields, the photo
 * columns that `resolveEventImageUrls` turns into `image` and then drops) and the
 * timestamps the app's cache compares.
 *
 * Left out, as back office only: `notes` (imported library notes), the AI review
 * flags (`...Reviewed`), `eventCode` and `s3Prefix` (the bucket layout), the library
 * import (`wixId`, `librarySnapshot`), the video credits (`creditLines`,
 * `copyrightHolder`, burnt into the videos), the announcement bookkeeping
 * (`publishedNotified...`) and the hero re-edit state (original, crop, grayscale).
 */
export const EVENT_CLIENT_COLUMNS = {
  id: true,
  titleEn: true,
  titlePt: true,
  mainThemesEn: true,
  mainThemesPt: true,
  sessionThemesEn: true,
  sessionThemesPt: true,
  startDate: true,
  endDate: true,
  eventTypeId: true,
  audienceId: true,
  bibliography: true,
  bibliographyPt: true,
  originalLanguage: true,
  status: true,
  audioPublished: true,
  videoPublished: true,
  transcriptsPublished: true,
  textsPublished: true,
  topicsPublished: true,
  imageUrl: true,
  avatarS3Key: true,
  heroS3Key: true,
  heroMobileS3Key: true,
  heroFocalX: true,
  heroFocalY: true,
  heroScale: true,
  heroFrameOverrides: true,
  avatarUpdatedAt: true,
  heroUpdatedAt: true,
  featuredAt: true,
  saleMode: true,
  priceCents: true,
  includedInMembership: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Every session column but the AI review flags. */
export const SESSION_CLIENT_COLUMNS = {
  id: true,
  eventId: true,
  titleEn: true,
  titlePt: true,
  sessionDate: true,
  timePeriod: true,
  sessionNumber: true,
  partNumber: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Every track column but the audio key and the AI review flags. `readAlongS3Key` is loaded only to derive
 * `hasReadAlong`: `toClientTrack` (or the speaker enrichment in events.ts) drops it.
 */
export const TRACK_CLIENT_COLUMNS = {
  id: true,
  sessionId: true,
  title: true,
  titleEn: true,
  titlePt: true,
  trackNumber: true,
  position: true,
  speaker: true,
  languages: true,
  originalLanguage: true,
  isTranslation: true,
  isPractice: true,
  fileFormat: true,
  originalTrackId: true,
  durationSeconds: true,
  fileSizeBytes: true,
  originalFilename: true,
  bitrateKbps: true,
  sampleRateHz: true,
  channels: true,
  readAlongS3Key: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The event-video fields the app reads (and `sessionId`). The slide document, the
 * retained master's key and the burn pipeline state are admin-only: the slides are
 * burnt into the video, so a client has no use for them.
 */
export const VIDEO_CLIENT_COLUMNS = {
  id: true,
  eventId: true,
  bunnyVideoId: true,
  position: true,
  titleEn: true,
  titlePt: true,
  videoDate: true,
  durationSeconds: true,
  posterUrl: true,
  sessionId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Every event-file column but the storage key (the file is served by /api/media/file/:id). */
export const EVENT_FILE_CLIENT_COLUMNS = {
  id: true,
  eventId: true,
  sessionId: true,
  originalFilename: true,
  fileType: true,
  extension: true,
  fileSizeBytes: true,
  language: true,
  sensitive: true,
  title: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * A track served without the speaker enrichment: expose `hasReadAlong` and drop the
 * read-along key, in place. Call it after the read-along visibility rule.
 */
export function toClientTrack(track: unknown): void {
  if (!track || typeof track !== "object") return;
  const t = track as { readAlongS3Key?: unknown; hasReadAlong?: unknown };
  if ("readAlongS3Key" in t) {
    t.hasReadAlong = !!t.readAlongS3Key;
    delete t.readAlongS3Key;
  }
}
