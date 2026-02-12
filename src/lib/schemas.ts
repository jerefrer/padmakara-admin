import { z } from "zod";

// Auth
export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export const requestMagicLinkSchema = z.object({
  email: z.email(),
  language: z.enum(["en", "pt"]).optional().default("en"),
});

export const verifyMagicLinkSchema = z.object({
  token: z.string().min(1),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

// Teachers
export const createTeacherSchema = z.object({
  name: z.string().min(1).max(200),
  abbreviation: z.string().min(1).max(50),
  photoUrl: z.string().url().optional().nullable(),
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
  slug: z.string().min(1).max(100),
  description: z.string().optional().nullable(),
  logoUrl: z.string().url().optional().nullable(),
  displayOrder: z.number().int().min(0).optional().default(0),
});

export const updateRetreatGroupSchema = createRetreatGroupSchema.partial();

// Retreats
export const createRetreatSchema = z.object({
  eventCode: z.string().min(1).max(100),
  titleEn: z.string().min(1).max(200),
  titlePt: z.string().max(200).optional().nullable(),
  descriptionEn: z.string().optional().nullable(),
  descriptionPt: z.string().optional().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  designation: z.string().min(1),
  audience: z.enum(["public", "subscribers", "members", "participants", "initiated", "by_request"]).optional().default("members"),
  bibliography: z.string().optional().nullable(),
  sessionThemes: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  status: z.enum(["draft", "published", "archived"]).optional().default("draft"),
  imageUrl: z.string().url().optional().nullable(),
  teacherIds: z.array(z.object({
    id: z.number().int(),
    role: z.enum(["teacher", "guest", "translator"]).optional().default("teacher"),
  })).optional().default([]),
  groupIds: z.array(z.number().int()).optional().default([]),
  placeIds: z.array(z.number().int()).optional().default([]),
});

export const updateRetreatSchema = createRetreatSchema.partial();

// Sessions
export const createSessionSchema = z.object({
  retreatId: z.number().int(),
  titleEn: z.string().max(200).optional().nullable(),
  titlePt: z.string().max(200).optional().nullable(),
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timePeriod: z.enum(["morning", "afternoon", "evening", "full_day"]).optional().default("morning"),
  sessionNumber: z.number().int().min(1),
  description: z.string().optional().nullable(),
});

export const updateSessionSchema = createSessionSchema.partial();

// Tracks
export const createTrackSchema = z.object({
  sessionId: z.number().int(),
  title: z.string().min(1).max(200),
  trackNumber: z.number().int().min(1),
  language: z.string().min(2).max(10).optional().default("en"),
  isTranslation: z.boolean().optional().default(false),
  originalTrackId: z.number().int().optional().nullable(),
  s3Key: z.string().optional().nullable(),
  durationSeconds: z.number().int().min(0).optional().default(0),
  fileSizeBytes: z.number().int().min(0).optional().nullable(),
  originalFilename: z.string().optional().nullable(),
});

export const updateTrackSchema = createTrackSchema.partial();

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

export const createNoteSchema = z.object({
  retreatId: z.number().int().optional().nullable(),
  trackId: z.number().int().optional().nullable(),
  title: z.string().max(200).optional().nullable(),
  content: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
});

export const updateNoteSchema = createNoteSchema.partial();

// Upload
export const presignUploadSchema = z.object({
  files: z.array(z.object({
    filename: z.string().min(1),
    contentType: z.string().min(1),
    size: z.number().int().min(1),
  })),
  eventCode: z.string().min(1),
  sessionNumber: z.number().int().min(1),
});

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
});
