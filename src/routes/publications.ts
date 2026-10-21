import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { publications } from "../db/schema/publications.ts";
import {
  optionalAuthMiddleware,
  getOptionalUser,
} from "../middleware/auth.ts";
import { AppError } from "../lib/errors.ts";
import { generatePresignedDownloadUrl } from "../services/s3.ts";
import {
  isMemberOnlyAudience,
  openablePublications,
  publicationAudienceSlugs,
} from "../services/publication-access.ts";

export const publicationRoutes = new Hono();

/**
 * GET /api/publications — List published publications (optional auth)
 *
 * Query params:
 *   sort: "title" | "author" | "recent" (default: "title")
 *   language: filter by language
 *
 * Each publication is listed only to callers who can open it: see
 * services/publication-access.ts for the rule per audience.
 */
publicationRoutes.get("/", optionalAuthMiddleware, async (c) => {
  const sort = c.req.query("sort") || "title";
  const language = c.req.query("language");

  const authUser = getOptionalUser(c);

  // Fetch all publications
  const allPublished = await db
    .select()
    .from(publications);

  // Filter by language if requested
  let filtered = allPublished;
  if (language) {
    filtered = filtered.filter((p) => p.language === language);
  }

  const opened = await openablePublications(authUser, filtered);
  const visiblePubs = filtered.filter((p) => opened.has(p.id));

  // Drives the "become a member" banner, so it counts only what membership
  // would open: a member missing a retreat's texts gains nothing by joining.
  const slugById = await publicationAudienceSlugs();
  const hasHiddenPublications = filtered.some(
    (p) =>
      !opened.has(p.id) &&
      isMemberOnlyAudience(p.audienceId === null ? undefined : slugById.get(p.audienceId)),
  );

  // Sort
  const sorted = [...visiblePubs].sort((a, b) => {
    switch (sort) {
      case "author": {
        const authorA = (a.authors[0] || "").toLowerCase();
        const authorB = (b.authors[0] || "").toLowerCase();
        return authorA.localeCompare(authorB);
      }
      case "recent":
        return (b.publicationDate || "").localeCompare(
          a.publicationDate || "",
        );
      case "title":
      default:
        return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
    }
  });

  // Map to response shape — never expose S3 keys
  const mapped = await Promise.all(
    sorted.map(async (p) => {
      let coverImageUrl: string | null = null;
      if (p.coverImageS3Key) {
        coverImageUrl = await generatePresignedDownloadUrl(
          p.coverImageS3Key,
          3600,
        );
      }
      return {
        id: p.id,
        title: p.title,
        subtitle: p.subtitle,
        description: p.description,
        authors: p.authors,
        language: p.language,
        pageCount: p.pageCount,
        publicationDate: p.publicationDate,
        version: p.version,
        coverImageUrl,
        fileSizeBytes: p.fileSizeBytes,
        updatedAt: p.updatedAt,
      };
    }),
  );

  return c.json({ publications: mapped, hasHiddenPublications });
});

/**
 * GET /api/publications/:id/pdf — Get presigned PDF download URL.
 *
 * Public publications: open to anyone (auth not required).
 * Every other audience: see services/publication-access.ts. An unknown
 * audience is refused.
 *
 * Returns { url: string, expiresIn: 3600 }.
 */
publicationRoutes.get("/:id/pdf", optionalAuthMiddleware, async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw AppError.badRequest("Invalid publication ID");
  }

  const authUser = getOptionalUser(c);

  const [publication] = await db
    .select()
    .from(publications)
    .where(eq(publications.id, id));

  if (!publication) {
    throw AppError.notFound("Publication not found");
  }

  const opened = await openablePublications(authUser, [publication]);
  if (!opened.has(publication.id)) {
    // A signed-out visitor may only need to sign in; anyone else is refused.
    if (!authUser) {
      throw AppError.unauthorized();
    }
    throw AppError.forbidden("This publication is not open to your account");
  }

  const url = await generatePresignedDownloadUrl(publication.pdfS3Key, 3600);

  return c.json({ url, expiresIn: 3600 });
});
