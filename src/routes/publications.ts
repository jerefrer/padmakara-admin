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
import {
  canOpenPublication,
  publicationsOpenedByLinkedEvents,
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
 * services/publication-access.ts for the rule per access level.
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

  const isAdmin = authUser?.role === "admin" || authUser?.role === "superadmin";
  const openedByEvents = await publicationsOpenedByLinkedEvents(
    authUser,
    filtered.filter((p) => p.accessLevel === "events").map((p) => p.id),
  );
  const visiblePubs = filtered.filter((p) =>
    canOpenPublication(p.accessLevel, {
      isAdmin,
      canSeeSubscriber,
      openedByLinkedEvent: openedByEvents.has(p.id),
    }),
  );

  // Drives the "become a member" banner, so it counts only what membership
  // would open: a member missing a retreat's texts gains nothing by joining.
  const hasHiddenPublications =
    !canSeeSubscriber && filtered.some((p) => p.accessLevel === "subscribers");

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
 * Event publications: require a user who can open one of its linked events.
 * Any other access level is refused.
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

  if (publication.accessLevel !== "public") {
    if (!authUser) {
      throw AppError.unauthorized();
    }
    const isAdmin = authUser.role === "admin" || authUser.role === "superadmin";
    const canSeeSubscriber =
      publication.accessLevel === "subscribers" && (await canUserSeeSubscriberContent(authUser));
    const openedByLinkedEvent =
      publication.accessLevel === "events" &&
      (await publicationsOpenedByLinkedEvents(authUser, [publication.id])).has(publication.id);
    if (!canOpenPublication(publication.accessLevel, { isAdmin, canSeeSubscriber, openedByLinkedEvent })) {
      throw AppError.forbidden(
        publication.accessLevel === "events"
          ? "This publication is reserved for the participants of its events"
          : "Active subscription required to access this publication",
      );
    }
  }

  const url = await generatePresignedDownloadUrl(publication.pdfS3Key, 3600);

  return c.json({ url, expiresIn: 3600 });
});
