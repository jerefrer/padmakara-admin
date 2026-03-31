import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { publications } from "../db/schema/publications.ts";
import { users } from "../db/schema/users.ts";
import {
  optionalAuthMiddleware,
  getOptionalUser,
  authMiddleware,
  getUser,
} from "../middleware/auth.ts";
import { AppError } from "../lib/errors.ts";
import { generatePresignedDownloadUrl } from "../services/s3.ts";

function hasActiveSubscription(user: {
  subscriptionStatus: string;
  subscriptionExpiresAt: Date | null;
}): boolean {
  if (user.subscriptionStatus !== "active") return false;
  if (user.subscriptionExpiresAt && user.subscriptionExpiresAt < new Date())
    return false;
  return true;
}

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

  // Determine if user can see subscriber-only publications
  let canSeeSubscriber = false;
  if (authUser) {
    if (authUser.role === "admin" || authUser.role === "superadmin") {
      canSeeSubscriber = true;
    } else {
      const [dbUser] = await db
        .select({
          subscriptionStatus: users.subscriptionStatus,
          subscriptionExpiresAt: users.subscriptionExpiresAt,
        })
        .from(users)
        .where(eq(users.id, authUser.id));

      if (dbUser && hasActiveSubscription(dbUser)) {
        canSeeSubscriber = true;
      }
    }
  }

  // Fetch all published publications
  const allPublished = await db
    .select()
    .from(publications)
    .where(eq(publications.status, "published"));

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
        coverImageUrl,
        fileSizeBytes: p.fileSizeBytes,
        accessLevel: p.accessLevel,
      };
    }),
  );

  return c.json({ publications: mapped, hasHiddenPublications });
});

/**
 * GET /api/publications/:id/pdf — Get presigned PDF download URL (auth required)
 *
 * Checks publication exists and is published.
 * If accessLevel is "subscribers", checks user subscription or admin role.
 * Returns { url: string, expiresIn: 3600 }
 */
publicationRoutes.get("/:id/pdf", authMiddleware, async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    throw AppError.badRequest("Invalid publication ID");
  }

  const authUser = getUser(c);

  const [publication] = await db
    .select()
    .from(publications)
    .where(eq(publications.id, id));

  if (!publication || publication.status !== "published") {
    throw AppError.notFound("Publication not found");
  }

  // Check subscriber access
  if (publication.accessLevel === "subscribers") {
    let hasAccess = false;

    if (authUser.role === "admin" || authUser.role === "superadmin") {
      hasAccess = true;
    } else {
      const [dbUser] = await db
        .select({
          subscriptionStatus: users.subscriptionStatus,
          subscriptionExpiresAt: users.subscriptionExpiresAt,
        })
        .from(users)
        .where(eq(users.id, authUser.id));

      if (dbUser && hasActiveSubscription(dbUser)) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      throw AppError.forbidden(
        "Active subscription required to access this publication",
      );
    }
  }

  const url = await generatePresignedDownloadUrl(publication.pdfS3Key, 3600);

  return c.json({ url, expiresIn: 3600 });
});
