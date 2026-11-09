import { describe, it, expect, vi, beforeEach } from "vitest";
import { PDFDocument } from "pdf-lib";

vi.mock("../../src/services/s3.ts", () => ({
  getObjectBytes: vi.fn(),
  deleteObject: vi.fn().mockResolvedValue(undefined),
}));

import { getObjectBytes, deleteObject } from "../../src/services/s3.ts";
import { isProtectedPdf, rejectProtectedPdf } from "../../src/services/pdf-protection.ts";

async function plainPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  return doc.save();
}

/** A PDF whose trailer points to an encryption dictionary, as an exported "protected" PDF does. */
async function protectedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: "Standard", V: 1, R: 2 }));
  return doc.save({ useObjectStreams: false });
}

describe("isProtectedPdf", () => {
  it("should flag a PDF with an encryption dictionary", async () => {
    expect(await isProtectedPdf(await protectedPdf())).toBe(true);
  });

  it("should accept an ordinary PDF", async () => {
    expect(await isProtectedPdf(await plainPdf())).toBe(false);
  });

  it("should not call a file protected just because it is not a valid PDF", async () => {
    expect(await isProtectedPdf(new TextEncoder().encode("not a pdf"))).toBe(false);
  });
});

describe("rejectProtectedPdf", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should refuse a protected PDF with PDF_PROTECTED and delete it from storage", async () => {
    (getObjectBytes as any).mockResolvedValue({ body: await protectedPdf(), contentType: "application/pdf" });

    await expect(rejectProtectedPdf("events/X/transcripts/a.pdf")).rejects.toMatchObject({
      statusCode: 400,
      code: "PDF_PROTECTED",
    });
    expect(deleteObject).toHaveBeenCalledWith("events/X/transcripts/a.pdf");
  });

  it("should let an ordinary PDF through and keep it", async () => {
    (getObjectBytes as any).mockResolvedValue({ body: await plainPdf(), contentType: "application/pdf" });

    await expect(rejectProtectedPdf("events/X/transcripts/a.pdf")).resolves.toBeUndefined();
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
