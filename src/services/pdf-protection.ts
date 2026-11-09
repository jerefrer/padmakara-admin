import { PDFDocument } from "pdf-lib";
import { AppError } from "../lib/errors.ts";
import { deleteObject, getObjectBytes } from "./s3.ts";

export const PROTECTED_PDF_MESSAGE =
  "This PDF is password-protected. Export it again without a password or security settings, then upload it again.";

/**
 * Whether the PDF is encrypted, which is what makes the watermark refuse it
 * when a reader opens the document. Read through `isEncrypted` because
 * pdf-lib's EncryptedPDFError is compiled to ES5 and fails `instanceof`.
 * A file that is not a readable PDF is not reported as protected.
 */
export async function isProtectedPdf(bytes: Uint8Array): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.isEncrypted;
  } catch {
    return false;
  }
}

/**
 * Refuse an uploaded PDF that is password-protected: readers get it with
 * their name stamped on every page, which a protected PDF does not allow.
 * The object is deleted so it does not linger in the bucket.
 */
export async function rejectProtectedPdf(s3Key: string): Promise<void> {
  const { body } = await getObjectBytes(s3Key);
  if (!(await isProtectedPdf(body))) return;
  await deleteObject(s3Key).catch((err) =>
    console.error(`Failed to delete protected PDF ${s3Key}:`, err),
  );
  throw AppError.badRequest(PROTECTED_PDF_MESSAGE, "PDF_PROTECTED");
}
