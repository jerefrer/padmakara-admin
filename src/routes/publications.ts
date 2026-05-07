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
import { canUserSeeSubscriberContent } from "../services/access.ts";

export const publicationRoutes = new Hono();

/**
 * GET /api/publications — List published publications (optional auth)
 *
 * Query params:
 *   sort: "title" | "author" | "recent" (default: "title")
 *   language: filter by language
 *
 * If user is authenticated with active subscription or admin role,
 * subscriber-only publications are included.
 */
publicationRoutes.get("/", optionalAuthMiddleware, async (c) => {
  const sort = c.req.query("sort") || "title";
  const language = c.req.query("language");

  const authUser = getOptionalUser(c);
  const canSeeSubscriber = await canUserSeeSubscriberContent(authUser);

  // Fetch all publications
  const allPublished = await db
    .select()
    .from(publications);

  // Filter by language if requested
  let filtered = allPublished;
  if (language) {
    filtered = filtered.filter((p) => p.language === language);
  }

  // Separate public vs subscriber-only
  const publicPubs = filtered.filter((p) => p.accessLevel === "public");
  const subscriberPubs = filtered.filter(
    (p) => p.accessLevel === "subscribers",
  );

  const hasHiddenPublications = !canSeeSubscriber && subscriberPubs.length > 0;

  const visiblePubs = canSeeSubscriber
    ? [...publicPubs, ...subscriberPubs]
    : publicPubs;

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
        accessLevel: p.accessLevel,
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
 * Subscribers-only publications: require authenticated user with active
 * subscription (or admin/superadmin role).
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

  if (publication.accessLevel === "subscribers") {
    if (!authUser) {
      throw AppError.unauthorized();
    }
    const canSee = await canUserSeeSubscriberContent(authUser);
    if (!canSee) {
      throw AppError.forbidden(
        "Active subscription required to access this publication",
      );
    }
  }

  const url = await generatePresignedDownloadUrl(publication.pdfS3Key, 3600);

  return c.json({ url, expiresIn: 3600 });
});
