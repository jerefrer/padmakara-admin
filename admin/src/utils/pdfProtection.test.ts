// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertUnprotectedPdf, isProtectedPdfFile, PROTECTED_PDF_MESSAGE } from "./pdfProtection";

const pdf = (body: string, name = "t.pdf") => new File([body], name, { type: "application/pdf" });
const PLAIN = "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R /Size 2 >>\n%%EOF";
const PROTECTED = "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R /Encrypt 5 0 R /Size 6 >>\n%%EOF";

describe("isProtectedPdfFile", () => {
  it("should spot the encryption entry of a protected PDF", async () => {
    expect(await isProtectedPdfFile(pdf(PROTECTED))).toBe(true);
  });

  it("should accept an ordinary PDF", async () => {
    expect(await isProtectedPdfFile(pdf(PLAIN))).toBe(false);
  });

  it("should find the entry at the end of a file larger than the scanned head", async () => {
    const big = pdf("%PDF-1.7\n" + " ".repeat(3 * 1024 * 1024) + "trailer << /Encrypt 9 0 R >>\n%%EOF");
    expect(await isProtectedPdfFile(big)).toBe(true);
  });
});

describe("assertUnprotectedPdf", () => {
  it("should refuse a protected PDF with a message that says what to do", async () => {
    await expect(assertUnprotectedPdf(pdf(PROTECTED))).rejects.toThrow(PROTECTED_PDF_MESSAGE);
  });

  it("should not look inside files that are not PDFs", async () => {
    await expect(assertUnprotectedPdf(pdf(PROTECTED, "notes.docx"))).resolves.toBeUndefined();
  });
});
