import { createHash } from "node:crypto";
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
  isHiddenAudience,
  isMemberOnlyAudience,
  openablePublications,
  publicationAudienceSlugs,
} from "../services/publication-access.ts";
import {
  publicationStatusOpenTo,
  publicationStatusVisibleTo,
} from "../services/publication-status.ts";

export const publicationRoutes = new Hono();

/**
 * Identifies the PDF file without exposing its S3 key. Every upload gets a new
 * key, so the fingerprint changes when the file is replaced and only then; the
 * app compares it with its cached copy to offer the new file. The `version`
 * field cannot do this: it mirrors the edition printed in the book, which a
 * corrected file usually keeps.
 */
function pdfFingerprint(pdfS3Key: string): string {
  return createHash("sha256").update(pdfS3Key).digest("hex").slice(0, 16);
}

/**
 * GET /api/publications — List published publications (optional auth)
 *
 * Query params:
 *   sort: "title" | "author" | "recent" (default: "title")
 *   language: filter by language
 *
 * Each publication is listed only to callers who can open it: see
 * services/publication-access.ts for the rule per audience. Drafts are listed
 * to admins only; a forthcoming publication is listed (its `status` lets the
 * app show it as upcoming) but its PDF is refused: see services/publication-status.ts.
 */
publicationRoutes.get("/", optionalAuthMiddleware, async (c) => {
  const sort = c.req.query("sort") || "title";
  const language = c.req.query("language");

  const authUser = getOptionalUser(c);

  // Fetch all publications
  const allPublications = await db
    .select()
    .from(publications);

  const visibleStatuses = publicationStatusVisibleTo(authUser?.role);
  let filtered = allPublications.filter((p) => visibleStatuses.includes(p.status));

  // Filter by language if requested
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
        pdfFingerprint: pdfFingerprint(p.pdfS3Key),
        coverImageUrl,
        fileSizeBytes: p.fileSizeBytes,
        updatedAt: p.updatedAt,
        status: p.status,
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
 * Status: a draft is a 404 to non-admins. A forthcoming publication is refused
 * with 403 PUBLICATION_FORTHCOMING to the callers its audience lets in (the
 * others get the same answer as for a published one), admins excepted.
 *
 * Returns { url: string, expiresIn: 3600 }.
 */
publicationRoutes.get("/:id/pdf", optionalAuthMiddleware, async (c) => {
  const id = parseInt((c.req.param("id") ?? ""), 10);
  if (isNaN(id)) {
    throw AppError.badRequest("Invalid publication ID");
  }

  const authUser = getOptionalUser(c);

  const [publication] = await db
    .select()
    .from(publications)
    .where(eq(publications.id, id));

  if (!publication || !publicationStatusVisibleTo(authUser?.role).includes(publication.status)) {
    throw AppError.notFound("Publication not found");
  }

  const opened = await openablePublications(authUser, [publication]);
  if (!opened.has(publication.id)) {
    // A hidden publication must not even confirm that it exists.
    const slugById = await publicationAudienceSlugs();
    const slug = publication.audienceId === null ? undefined : slugById.get(publication.audienceId);
    if (slug && isHiddenAudience(slug)) {
      throw AppError.notFound("Publication not found");
    }
    // A signed-out visitor may only need to sign in; anyone else is refused.
    if (!authUser) {
      throw AppError.unauthorized();
    }
    throw AppError.forbidden("This publication is not open to your account");
  }

  // Announced, not available yet: checked after the audience so a caller
  // kept out learns no more than for a published text.
  if (!publicationStatusOpenTo(authUser?.role).includes(publication.status)) {
    throw new AppError(403, "This publication is not available yet", "PUBLICATION_FORTHCOMING");
  }

  const url = await generatePresignedDownloadUrl(publication.pdfS3Key, 3600);

  return c.json({ url, expiresIn: 3600 });
});
