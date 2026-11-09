/**
 * Readers get transcripts and documents with their name stamped on every page,
 * which a password-protected PDF does not allow, so such a PDF is refused
 * before it is uploaded. The server checks again when the row is created.
 */

export const PROTECTED_PDF_MESSAGE =
  "This PDF is password-protected. Export it again without a password or security settings, then upload it again.";

/** How much of each end of the file to read: the trailer naming the encryption sits there. */
const SCAN_BYTES = 1024 * 1024;

// The trailer (or cross-reference stream) points to the encryption dictionary.
const ENCRYPT_ENTRY = /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/;

export function isPdfFilename(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf");
}

/** Whether the PDF names an encryption dictionary, looking at its first and last megabyte. */
export async function isProtectedPdfFile(file: Blob): Promise<boolean> {
  const decoder = new TextDecoder("latin1");
  const head = decoder.decode(await file.slice(0, SCAN_BYTES).arrayBuffer());
  if (ENCRYPT_ENTRY.test(head)) return true;
  if (file.size <= SCAN_BYTES) return false;
  const tail = decoder.decode(await file.slice(Math.max(SCAN_BYTES, file.size - SCAN_BYTES)).arrayBuffer());
  return ENCRYPT_ENTRY.test(tail);
}

/** Throws with a message for the admin when `file` is a password-protected PDF. */
export async function assertUnprotectedPdf(file: File): Promise<void> {
  if (isPdfFilename(file.name) && (await isProtectedPdfFile(file))) {
    throw new Error(PROTECTED_PDF_MESSAGE);
  }
}
