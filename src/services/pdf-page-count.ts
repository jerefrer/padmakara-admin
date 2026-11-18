/**
 * Count the pages of a PDF via poppler's pdfinfo. Robust against malformed
 * cross-reference tables that crash pdf-lib. Shared by publications and
 * transcripts, which both store a page count computed from the uploaded file.
 */
export async function getPdfPageCount(pdfBuffer: Uint8Array): Promise<number> {
  const proc = Bun.spawn(["pdfinfo", "-"], {
    stdin: new Blob([pdfBuffer as Uint8Array<ArrayBuffer>]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`pdfinfo failed (exit ${exitCode}): ${stderr.substring(0, 200)}`);
  }

  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) {
    throw new Error(`pdfinfo did not return a page count: ${stdout.substring(0, 200)}`);
  }
  // match[1] is always defined when the regex matched (capturing group 1 is required)
  return parseInt(match[1]!, 10);
}
