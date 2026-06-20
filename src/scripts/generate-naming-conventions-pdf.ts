/**
 * Generate `admin/public/naming-conventions.pdf` from `docs/NAMING-CONVENTIONS.md`.
 *
 * Runs at deploy time (before the admin Vite build copies `public/` into
 * `dist/`) and locally via `bun run pdf:naming`. Pure JS (pdfmake) — no system
 * dependency, no headless browser.
 *
 * The Markdown subset handled is exactly what NAMING-CONVENTIONS.md uses:
 * `#`/`##`/`###` headings, paragraphs with `**bold**` and `` `inline code` ``,
 * `-` bullet lists and `1.` ordered lists (with indented continuation lines),
 * GFM pipe tables, and ``` fenced code blocks. Anything outside that subset is
 * rendered as plain text rather than failing.
 */
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import PdfPrinter from "pdfmake";
import vfsModule from "pdfmake/build/vfs_fonts.js";

const here = dirname(fileURLToPath(import.meta.url));
const MD_PATH = join(here, "../../docs/NAMING-CONVENTIONS.md");
const OUT_PATH = join(here, "../../admin/public/naming-conventions.pdf");

// pdfmake ships Roboto as base64 in its browser VFS. Decode the four faces we
// need to temp files so the server-side PdfPrinter can read them — keeps the
// repo free of committed font binaries.
const vfs: Record<string, string> =
  (vfsModule as any).pdfMake?.vfs ??
  (vfsModule as any).vfs ??
  (vfsModule as any).default?.pdfMake?.vfs ??
  (vfsModule as any).default?.vfs ??
  (vfsModule as any);

const fontDir = mkdtempSync(join(tmpdir(), "padmakara-pdf-fonts-"));
function fontFile(name: string): string {
  const path = join(fontDir, name);
  writeFileSync(path, Buffer.from(vfs[name]!, "base64"));
  return path;
}
const fonts = {
  Roboto: {
    normal: fontFile("Roboto-Regular.ttf"),
    bold: fontFile("Roboto-Medium.ttf"),
    italics: fontFile("Roboto-Italic.ttf"),
    bolditalics: fontFile("Roboto-MediumItalic.ttf"),
  },
};

type Run = { text: string; bold?: boolean; style?: string };

/** Parse `**bold**` and `` `inline code` `` (including code nested in bold). */
function parseInline(text: string): string | Run[] {
  const runs: Run[] = [];
  // Split a plain segment on `code` spans, tagging each run bold or not.
  const pushWithCode = (segment: string, bold: boolean) => {
    const codeRe = /`([^`]+)`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = codeRe.exec(segment))) {
      if (m.index > last) runs.push({ text: segment.slice(last, m.index), ...(bold && { bold }) });
      runs.push({ text: m[1]!, style: "code", ...(bold && { bold }) });
      last = codeRe.lastIndex;
    }
    if (last < segment.length) runs.push({ text: segment.slice(last), ...(bold && { bold }) });
  };

  const boldRe = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = boldRe.exec(text))) {
    if (m.index > last) pushWithCode(text.slice(last, m.index), false);
    pushWithCode(m[1]!, true);
    last = boldRe.lastIndex;
  }
  if (last < text.length) pushWithCode(text.slice(last), false);

  if (runs.length === 0) return text;
  if (runs.length === 1 && !runs[0]!.bold && !runs[0]!.style) return runs[0]!.text;
  return runs;
}

function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("|")) return false;
  return splitRow(line).every((c) => /^:?-{2,}:?$/.test(c) || c === "---");
}

const md = readFileSync(MD_PATH, "utf8").replace(/\r\n/g, "\n");
const lines = md.split("\n");
const content: any[] = [];
let i = 0;

while (i < lines.length) {
  const line = lines[i]!;
  const trimmed = line.trim();

  // Fenced code block
  if (trimmed.startsWith("```")) {
    const code: string[] = [];
    i++;
    while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
      code.push(lines[i]!);
      i++;
    }
    i++; // closing fence
    content.push({
      table: {
        widths: ["*"],
        body: [[{ text: code.join("\n"), style: "code", margin: [6, 6, 6, 6] }]],
      },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        fillColor: () => "#f5f3f0",
      },
      margin: [0, 4, 0, 10],
    });
    continue;
  }

  // GFM pipe table: a header row followed by a separator row
  if (
    trimmed.startsWith("|") &&
    i + 1 < lines.length &&
    isTableSeparator(lines[i + 1]!)
  ) {
    const header = splitRow(line).map((c) => ({
      text: parseInline(c),
      style: "th",
    }));
    i += 2; // header + separator
    const body: any[] = [header];
    while (i < lines.length && lines[i]!.trim().startsWith("|")) {
      body.push(splitRow(lines[i]!).map((c) => ({ text: parseInline(c) })));
      i++;
    }
    content.push({
      table: { headerRows: 1, widths: header.map(() => "*"), body },
      layout: "lightHorizontalLines",
      margin: [0, 4, 0, 12],
    });
    continue;
  }

  // Headings
  const heading = /^(#{1,3})\s+(.*)$/.exec(line);
  if (heading) {
    const level = heading[1]!.length;
    content.push({ text: parseInline(heading[2]!), style: `h${level}` });
    i++;
    continue;
  }

  // Bullet / ordered lists (with indented continuation lines)
  const isBullet = /^\s*-\s+/.test(line);
  const isOrdered = /^\s*\d+\.\s+/.test(line);
  if (isBullet || isOrdered) {
    const items: any[] = [];
    const marker = isBullet ? /^\s*-\s+/ : /^\s*\d+\.\s+/;
    while (i < lines.length) {
      const cur = lines[i]!;
      if (marker.test(cur)) {
        items.push(cur.replace(marker, ""));
      } else if (cur.trim() !== "" && /^\s+/.test(cur) && items.length > 0) {
        // Indented continuation of the previous item
        items[items.length - 1] += " " + cur.trim();
      } else {
        break;
      }
      i++;
    }
    const listKey = isBullet ? "ul" : "ol";
    content.push({
      [listKey]: items.map((t) => parseInline(t)),
      margin: [0, 2, 0, 10],
    });
    continue;
  }

  // Blank line
  if (trimmed === "") {
    i++;
    continue;
  }

  // Horizontal rule
  if (/^-{3,}$/.test(trimmed)) {
    content.push({
      canvas: [
        { type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#cccccc" },
      ],
      margin: [0, 6, 0, 10],
    });
    i++;
    continue;
  }

  // Paragraph: gather consecutive plain lines
  const para: string[] = [];
  while (
    i < lines.length &&
    lines[i]!.trim() !== "" &&
    !/^(#{1,3})\s/.test(lines[i]!) &&
    !lines[i]!.trim().startsWith("```") &&
    !lines[i]!.trim().startsWith("|") &&
    !/^\s*-\s+/.test(lines[i]!) &&
    !/^\s*\d+\.\s+/.test(lines[i]!)
  ) {
    para.push(lines[i]!.trim());
    i++;
  }
  content.push({ text: parseInline(para.join(" ")), margin: [0, 0, 0, 8] });
}

const docDefinition = {
  content,
  defaultStyle: { font: "Roboto", fontSize: 10, lineHeight: 1.3, color: "#222222" },
  pageMargins: [40, 48, 40, 48] as [number, number, number, number],
  styles: {
    h1: { fontSize: 22, bold: true, color: "#9b1b1b", margin: [0, 0, 0, 10] },
    h2: { fontSize: 15, bold: true, color: "#9b1b1b", margin: [0, 14, 0, 6] },
    h3: { fontSize: 12, bold: true, margin: [0, 8, 0, 4] },
    th: { bold: true, fillColor: "#f5f3f0", color: "#000000" },
    code: { color: "#9b1b1b" },
  },
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
const printer = new (PdfPrinter as any)(fonts);
const pdfDoc = printer.createPdfKitDocument(docDefinition);
const chunks: Buffer[] = [];

await new Promise<void>((resolve, reject) => {
  pdfDoc.on("data", (c: Buffer) => chunks.push(c));
  pdfDoc.on("end", () => resolve());
  pdfDoc.on("error", reject);
  pdfDoc.end();
});

writeFileSync(OUT_PATH, Buffer.concat(chunks));
console.log(`Wrote ${OUT_PATH} (${Buffer.concat(chunks).length} bytes)`);
