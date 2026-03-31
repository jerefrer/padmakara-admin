import { Hono } from "hono";
import { eq, or, ilike } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { publications } from "../../db/schema/publications.ts";
import { createPublicationSchema, updatePublicationSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { generatePresignedDownloadUrl, generatePresignedUploadUrl } from "../../services/s3.ts";
import { PDFDocument } from "pdf-lib";

const publicationRoutes = new Hono();

const columns: Record<string, any> = {
  id: publications.id,
  titlePt: publications.titlePt,
  titleEn: publications.titleEn,
  language: publications.language,
  accessLevel: publications.accessLevel,
  status: publications.status,
  publicationDate: publications.publicationDate,
  createdAt: publications.createdAt,
  sortOrder: publications.sortOrder,
};

async function addCoverImageUrl<T extends { coverImageS3Key: string | null }>(
  pub: T,
): Promise<T & { coverImageUrl: string | null }> {
  const coverImageUrl = pub.coverImageS3Key
    ? await generatePresignedDownloadUrl(pub.coverImageS3Key)
    : null;
  return { ...pub, coverImageUrl };
}

/**
 * GET / — List publications with pagination, sort, search
 */
publicationRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);
  const q = c.req.query("q");

  const where = q
    ? or(
        ilike(publications.titlePt, `%${q}%`),
        ilike(publications.titleEn, `%${q}%`),
        ilike(publications.subtitle, `%${q}%`),
      )
    : undefined;

  const [data, total] = await Promise.all([
    db.select().from(publications).where(where).orderBy(orderBy!).limit(limit).offset(offset),
    countRows(publications, where),
  ]);

  const dataWithUrls = await Promise.all(data.map(addCoverImageUrl));

  return listResponse(c, dataWithUrls, total, offset, offset + limit, "publications");
});

/**
 * GET /:id — Single publication detail
 */
publicationRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const pub = await db.query.publications.findFirst({
    where: eq(publications.id, id),
  });
  if (!pub) throw AppError.notFound("Publication not found");
  return c.json(await addCoverImageUrl(pub));
});

/**
 * POST / — Create a new publication
 */
publicationRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createPublicationSchema.parse(body);

  let { pageCount, fileSizeBytes } = data;
  if (data.pdfS3Key && (pageCount == null || fileSizeBytes == null)) {
    try {
      const pdfUrl = await generatePresignedDownloadUrl(data.pdfS3Key);
      const response = await fetch(pdfUrl);
      const pdfBytes = new Uint8Array(await response.arrayBuffer());
      if (fileSizeBytes == null) fileSizeBytes = pdfBytes.byteLength;
      if (pageCount == null) {
        const pdfDoc = await PDFDocument.load(pdfBytes);
        pageCount = pdfDoc.getPageCount();
      }
    } catch (err) {
      console.error("Failed to extract PDF metadata:", err);
    }
  }

  const [pub] = await db
    .insert(publications)
    .values({ ...data, pageCount, fileSizeBytes })
    .returning();
  return c.json(pub!, 201);
});

/**
 * PUT /:id — Update a publication
 */
publicationRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updatePublicationSchema.parse(body);

  let { pageCount, fileSizeBytes } = data;
  if (data.pdfS3Key && (pageCount == null || fileSizeBytes == null)) {
    try {
      const pdfUrl = await generatePresignedDownloadUrl(data.pdfS3Key);
      const response = await fetch(pdfUrl);
      const pdfBytes = new Uint8Array(await response.arrayBuffer());
      if (fileSizeBytes == null) fileSizeBytes = pdfBytes.byteLength;
      if (pageCount == null) {
        const pdfDoc = await PDFDocument.load(pdfBytes);
        pageCount = pdfDoc.getPageCount();
      }
    } catch (err) {
      console.error("Failed to extract PDF metadata:", err);
    }
  }

  const [pub] = await db
    .update(publications)
    .set({ ...data, pageCount, fileSizeBytes, updatedAt: new Date() })
    .where(eq(publications.id, id))
    .returning();
  if (!pub) throw AppError.notFound("Publication not found");
  return c.json(pub);
});

/**
 * DELETE /:id — Delete a publication
 */
publicationRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [pub] = await db
    .delete(publications)
    .where(eq(publications.id, id))
    .returning();
  if (!pub) throw AppError.notFound("Publication not found");
  return c.json(pub);
});

/**
 * POST /presign-upload — Generate presigned upload URLs for cover image or PDF
 */
publicationRoutes.post("/presign-upload", async (c) => {
  const { filename, contentType, type } = (await c.req.json()) as {
    filename: string;
    contentType: string;
    type: "cover" | "pdf";
  };

  const ext = filename.split(".").pop() || "bin";
  const timestamp = Date.now();
  const s3Key =
    type === "cover"
      ? `publications/covers/${timestamp}.${ext}`
      : `publications/pdfs/${timestamp}.${ext}`;

  const uploadUrl = await generatePresignedUploadUrl(s3Key, contentType);

  return c.json({ s3Key, uploadUrl });
});

export { publicationRoutes };
