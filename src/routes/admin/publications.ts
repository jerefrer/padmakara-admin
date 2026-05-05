import { Hono } from "hono";
import { eq, or, ilike } from "drizzle-orm";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../../db/index.ts";
import { publications } from "../../db/schema/publications.ts";
import { teachers } from "../../db/schema/teachers.ts";
import { createPublicationSchema, updatePublicationSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import { generatePresignedDownloadUrl, generatePresignedUploadUrl, putObject } from "../../services/s3.ts";
import { PDFDocument } from "pdf-lib";

/**
 * Generate a cover image from the first page of a PDF.
 * Uses pdftoppm (poppler) via Bun.spawn to render page 1 to PNG, then sharp to resize to JPEG.
 * Returns a JPEG buffer at 2x retina resolution (240×320).
 */
async function generateCoverFromPdf(pdfBuffer: Buffer | Uint8Array): Promise<Buffer> {
  const proc = Bun.spawn(["pdftoppm", "-png", "-f", "1", "-l", "1", "-scale-to", "480", "-"], {
    stdin: new Blob([pdfBuffer]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`pdftoppm failed (exit ${exitCode}): ${stderr.substring(0, 200)}`);
  }

  return await sharp(Buffer.from(stdout))
    .resize({ width: 240 })
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
  title: publications.title,
  language: publications.language,
  accessLevel: publications.accessLevel,
  publicationDate: publications.publicationDate,
  createdAt: publications.createdAt,
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
        ilike(publications.title, `%${q}%`),
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
 * POST /extract-metadata — Use Claude AI to extract metadata from a PDF's first page
 */
publicationRoutes.post("/extract-metadata", async (c) => {
  const { pdfS3Key } = (await c.req.json()) as { pdfS3Key: string };
  if (!pdfS3Key) throw AppError.badRequest("pdfS3Key is required");

  // Download the PDF from S3
  const pdfUrl = await generatePresignedDownloadUrl(pdfS3Key);
  const response = await fetch(pdfUrl);
  if (!response.ok) throw new AppError(500,"Failed to download PDF from S3");
  const pdfBytes = new Uint8Array(await response.arrayBuffer());

  // Extract first page as a single-page PDF
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pageCount = pdfDoc.getPageCount();
  const singlePageDoc = await PDFDocument.create();
  const [copiedPage] = await singlePageDoc.copyPages(pdfDoc, [0]);
  singlePageDoc.addPage(copiedPage);
  const firstPagePdf = await singlePageDoc.save();
  const pdfBase64 = Buffer.from(firstPagePdf).toString("base64");

  // Fetch existing teachers for matching
  const allTeachers = await db.select().from(teachers);
  const teacherList = allTeachers
    .map(
      (t) =>
        `- ID ${t.id}: ${t.name} (${t.abbreviation})${t.aliases.length ? ` aliases: ${t.aliases.join(", ")}` : ""}`,
    )
    .join("\n");

  // Call Claude Haiku for metadata extraction
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AppError(500,"ANTHROPIC_API_KEY not configured");

  const anthropic = new Anthropic({ apiKey });

  let aiResponse;
  try {
    aiResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdfBase64,
              },
            },
            {
              type: "text",
              text: `Extract metadata from this Buddhist publication cover/first page. Return a JSON object with these fields.

TITLE STRUCTURE (very important — covers often contain up to FOUR title elements arranged vertically):
1. TIBETAN-SCRIPT TITLE at the very top, in Tibetan script (༄༅། །བླ་སྤྲུལ་…). IGNORE this — do not include it anywhere in the output.
2. SUBTITLE: smaller italic line(s) ABOVE the main title (e.g. "As Práticas Preliminares d'A Quintessência do Guru Kīlaya").
3. MAIN TITLE: the most prominent text, usually in LARGE CAPITALS / SMALL-CAPS in the center of the cover (e.g. "O EXCELENTE CAMINHO DA LIBERTAÇÃO"). This is the primary title in a European language (Portuguese, English, French).
4. PHONETIC / ROMANIZED TIBETAN NAME: an italic line BELOW the main title with a transliteration of the Tibetan title (e.g. "Laphur Thugtik Ngöndro"). Append this in parentheses to the main title.

Fields:
- "title": Main title (CAPS/center) followed by the romanized/phonetic Tibetan name in parentheses if it exists below the main title (e.g. "O Excelente Caminho da Libertação (Laphur Thugtik Ngöndro)"). Never use the Tibetan-script title. If no romanized name appears below, return just the main title.
- "subtitle": The italic subtitle ABOVE the main title. Otherwise null. Do NOT put the romanized Tibetan name here.
- "authors": Array of author/translator names found. Look for names after "by", "par", "por", "traduit par", "translated by", or listed prominently near the bottom (e.g. "Kangyur Rinpoche, Longchen Yeshe Dorje").
- "language": Primary language of the MAIN title: "pt" for Portuguese, "en" for English, "fr" for French, "tib" for Tibetan only, etc.
- "description": Brief description if a blurb or summary is visible, otherwise null.
- "publicationDate": Publication date if visible, as "YYYY-MM-DD" format. If only month + year are shown (e.g. "Março 2026"), use day "01" (→ "2026-03-01"). Otherwise null.
- "version": The document version string if printed on the cover (often vertically along the spine/edge, e.g. "V.1.2 - Março 2026", "v2.0", "Version 1.0"). Return the version label exactly as printed (e.g. "V.1.2"). If a date is included next to the version, keep it ("V.1.2 - Março 2026"). Otherwise null.

Also, here are the known teachers in our system. If any author matches or is clearly the same person as one of these teachers, include their ID:
${teacherList}

- "matchedTeacherIds": Array of teacher IDs (numbers) that match authors found on this page. Only include confident matches.

Return ONLY the JSON object, no markdown fences, no explanation.`,
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error("Claude API error:", err);
    throw new AppError(500, `Claude API call failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Parse Claude's response
  const textBlock = aiResponse.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new AppError(500, "No text response from Claude");
  }

  let extracted: Record<string, unknown>;
  try {
    let rawText = textBlock.text.trim();
    // Strip markdown code fences if present
    if (rawText.startsWith("```")) {
      rawText = rawText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    }
    extracted = JSON.parse(rawText);
  } catch {
    console.error("Claude response was not valid JSON:", textBlock.text);
    throw new AppError(500, "Failed to parse Claude response as JSON");
  }

  // Auto-generate cover from first page
  let coverImageS3Key: string | null = null;
  let coverImageUrl: string | null = null;
  try {
    const coverBuffer = await generateCoverFromPdf(pdfBytes);
    coverImageS3Key = `publications/covers/${Date.now()}-auto.jpg`;
    await putObject(coverImageS3Key, coverBuffer, "image/jpeg");
    coverImageUrl = await generatePresignedDownloadUrl(coverImageS3Key);
  } catch (err) {
    console.error("Failed to auto-generate cover image:", err);
  }

  return c.json({
    title: (extracted.title as string) || "",
    subtitle: (extracted.subtitle as string) || null,
    authors: Array.isArray(extracted.authors) ? extracted.authors : [],
    language: (extracted.language as string) || "pt",
    description: (extracted.description as string) || null,
    publicationDate: (extracted.publicationDate as string) || null,
    version: (extracted.version as string) || null,
    matchedTeacherIds: Array.isArray(extracted.matchedTeacherIds)
      ? extracted.matchedTeacherIds
      : [],
    pageCount,
    fileSizeBytes: pdfBytes.byteLength,
    coverImageS3Key,
    coverImageUrl,
  });
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

  // Fetch existing record so we can detect a real PDF change and force cover
  // regeneration when it happens. The version label usually appears on the
  // cover, so a stale auto-cover after a PDF replacement would be wrong.
  const existing = await db.query.publications.findFirst({
    where: eq(publications.id, id),
  });
  if (!existing) throw AppError.notFound("Publication not found");

  let pageCount = data.pageCount;
  let fileSizeBytes = data.fileSizeBytes;
  let coverImageS3Key = data.coverImageS3Key;

  if (data.pdfS3Key) {
    const pdfChanged = data.pdfS3Key !== existing.pdfS3Key;
    try {
      // Pass null when the PDF changed so extractPdfMetadata regenerates the
      // cover; otherwise preserve any existing/manual cover.
      const metadata = await extractPdfMetadata(
        data.pdfS3Key,
        pdfChanged ? null : coverImageS3Key,
        id,
      );
      pageCount = metadata.pageCount;
      fileSizeBytes = metadata.fileSizeBytes;
      if (pdfChanged || !coverImageS3Key) {
        coverImageS3Key = metadata.coverImageS3Key;
      }
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
