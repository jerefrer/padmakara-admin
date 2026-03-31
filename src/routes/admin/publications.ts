import { Hono } from "hono";
import { eq, or, ilike } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../../db/index.ts";
import { publications } from "../../db/schema/publications.ts";
import { createPublicationSchema, updatePublicationSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { generatePresignedDownloadUrl, generatePresignedUploadUrl, putObject } from "../../services/s3.ts";
import { PDFDocument } from "pdf-lib";

/**
 * Generate a cover image from the first page of a PDF.
 * Returns a JPEG buffer at 2x retina resolution (240×320) for the 60×80 list thumbnails.
 */
async function generateCoverFromPdf(pdfBuffer: Buffer | Uint8Array): Promise<Buffer> {
  return await sharp(Buffer.from(pdfBuffer), { page: 0, density: 150 })
    .resize(240, 320, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

/**
 * Extract PDF metadata and optionally auto-generate a cover image.
 * Returns updated pageCount, fileSizeBytes, and coverImageS3Key.
 */
async function extractPdfMetadata(
  pdfS3Key: string,
  existingCoverS3Key: string | null | undefined,
  publicationId?: number,
): Promise<{
  pageCount: number | null;
  fileSizeBytes: number | null;
  coverImageS3Key: string | null;
}> {
  const pdfUrl = await generatePresignedDownloadUrl(pdfS3Key);
  const response = await fetch(pdfUrl);
  const pdfBytes = new Uint8Array(await response.arrayBuffer());

  const fileSizeBytes = pdfBytes.byteLength;

  let pageCount: number | null = null;
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    pageCount = pdfDoc.getPageCount();
  } catch (err) {
    console.error("Failed to extract page count:", err);
  }

  // Auto-generate cover from first page if no custom cover is set
  let coverImageS3Key = existingCoverS3Key || null;
  if (!coverImageS3Key) {
    try {
      const coverBuffer = await generateCoverFromPdf(pdfBytes);
      const suffix = publicationId || Date.now();
      coverImageS3Key = `publications/covers/${suffix}-auto.jpg`;
      await putObject(coverImageS3Key, coverBuffer, "image/jpeg");
    } catch (err) {
      console.error("Failed to auto-generate cover image:", err);
    }
  }

  return { pageCount, fileSizeBytes, coverImageS3Key };
}

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

  let { pageCount, fileSizeBytes, coverImageS3Key } = data;
  if (data.pdfS3Key) {
    try {
      const metadata = await extractPdfMetadata(data.pdfS3Key, coverImageS3Key);
      pageCount = metadata.pageCount;
      fileSizeBytes = metadata.fileSizeBytes;
      coverImageS3Key = metadata.coverImageS3Key;
    } catch (err) {
      console.error("Failed to extract PDF metadata:", err);
    }
  }

  const [pub] = await db
    .insert(publications)
    .values({ ...data, pageCount, fileSizeBytes, coverImageS3Key })
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

  let pageCount = data.pageCount;
  let fileSizeBytes = data.fileSizeBytes;
  let coverImageS3Key = data.coverImageS3Key;

  // Re-extract metadata when the PDF changes
  if (data.pdfS3Key) {
    try {
      const metadata = await extractPdfMetadata(data.pdfS3Key, coverImageS3Key, id);
      pageCount = metadata.pageCount;
      fileSizeBytes = metadata.fileSizeBytes;
      if (!coverImageS3Key) coverImageS3Key = metadata.coverImageS3Key;
    } catch (err) {
      console.error("Failed to extract PDF metadata:", err);
    }
  }

  const [pub] = await db
    .update(publications)
    .set({ ...data, pageCount, fileSizeBytes, coverImageS3Key, updatedAt: new Date() })
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
