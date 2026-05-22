import type ExcelJSNamespace from "exceljs";

/** One track for the review spreadsheet — original vs corrected values. */
export interface TrackExportRow {
  session: string;
  trackNumber: number | string;
  originalFilename: string;
  correctedFilename: string;
  originalTitle: string;
  correctedTitle: string;
  changes: string;
}

const RED = "FFB00020"; // characters present only in the original
const GREEN = "FF2E7D32"; // characters present only in the corrected
const HEADER_BG = "FF5B5EA6"; // brand-ish indigo
const THIN = { style: "thin" as const, color: { argb: "FFD0D0D0" } };
const MONO = { name: "Menlo", size: 10 };

// ─── Character-level diff (LCS) ───────────────────────────────────────────
// Marks each character of `a` and `b` as common (in the longest common
// subsequence) or changed, so we can bold just the differing characters.

interface Seg {
  text: string;
  changed: boolean;
}

function diffSegments(a: string, b: string): { aSegs: Seg[]; bSegs: Seg[] } {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const aCommon = new Array<boolean>(n).fill(false);
  const bCommon = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      aCommon[i] = true;
      bCommon[j] = true;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return { aSegs: toSegs(a, aCommon), bSegs: toSegs(b, bCommon) };
}

/** Merge consecutive same-state characters into runs. */
function toSegs(s: string, common: boolean[]): Seg[] {
  const segs: Seg[] = [];
  for (let k = 0; k < s.length; k++) {
    const changed = !common[k];
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += s[k];
    else segs.push({ text: s[k]!, changed });
  }
  return segs;
}

/** Build an exceljs rich-text value: changed chars bold + coloured. */
function richText(
  segs: Seg[],
  changedColor: string,
  mono: boolean,
): ExcelJSNamespace.CellValue {
  return {
    richText: segs.map((seg) => ({
      text: seg.text,
      font: seg.changed
        ? { ...(mono ? MONO : {}), bold: true, color: { argb: changedColor } }
        : { ...(mono ? MONO : {}) },
    })),
  } as ExcelJSNamespace.CellValue;
}

/**
 * Build and download a styled .xlsx for human review. Each track spans two
 * rows: the original value on top, the corrected value below. Within a changed
 * value, only the characters that actually differ are bolded and coloured
 * (red in the original, green in the corrected); everything else stays plain.
 * Unchanged fields are merged into a single cell. Session / # / comment cells
 * are merged across the two rows so each track reads as one block.
 *
 * Uses exceljs (not SheetJS community) because only exceljs writes cell
 * styling — fonts, fills, colours, rich text — to .xlsx in its open build.
 */
export async function exportTracksToXlsx(
  rows: TrackExportRow[],
  filename: string,
): Promise<void> {
  // Dynamic import keeps exceljs (~heavy) out of the main admin bundle — it
  // only loads when the admin actually exports.
  const ExcelJS = (await import("exceljs")).default as typeof ExcelJSNamespace;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Tracks", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  ws.columns = [
    { width: 22 }, // A Session
    { width: 6 }, // B #
    { width: 52 }, // C Filename
    { width: 44 }, // D Title
    { width: 26 }, // E What changed
  ];

  // ── Header row ──────────────────────────────────────────────────────
  const header = ws.addRow(["Session", "#", "Filename", "Title", "What changed"]);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_BG } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
  });

  // ── One block (two rows) per track ──────────────────────────────────
  for (const r of rows) {
    const top = ws.addRow([r.session, r.trackNumber, "", "", r.changes]);
    const bottom = ws.addRow(["", "", "", "", ""]);
    const tr = top.number;
    const br = bottom.number;

    // Session / # / What changed: merge the two rows into one centred cell.
    ws.mergeCells(`A${tr}:A${br}`);
    ws.mergeCells(`B${tr}:B${br}`);
    ws.mergeCells(`E${tr}:E${br}`);

    const filenameChanged = r.originalFilename !== r.correctedFilename;
    const titleChanged = r.originalTitle !== r.correctedTitle;

    if (filenameChanged) {
      const { aSegs, bSegs } = diffSegments(r.originalFilename, r.correctedFilename);
      ws.getCell(`C${tr}`).value = richText(aSegs, RED, true);
      ws.getCell(`C${br}`).value = richText(bSegs, GREEN, true);
    } else {
      ws.mergeCells(`C${tr}:C${br}`);
      ws.getCell(`C${tr}`).value = r.originalFilename;
      ws.getCell(`C${tr}`).font = MONO;
    }

    if (titleChanged) {
      const { aSegs, bSegs } = diffSegments(r.originalTitle, r.correctedTitle);
      ws.getCell(`D${tr}`).value = richText(aSegs, RED, false);
      ws.getCell(`D${br}`).value = richText(bSegs, GREEN, false);
    } else {
      ws.mergeCells(`D${tr}:D${br}`);
      ws.getCell(`D${tr}`).value = r.originalTitle;
    }

    // Shared formatting for both rows of the block. Everything centred
    // vertically; monospace on the filename column.
    for (const rowNum of [tr, br]) {
      for (const col of ["A", "B", "C", "D", "E"]) {
        const cell = ws.getCell(`${col}${rowNum}`);
        cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
        cell.alignment = {
          vertical: "middle",
          horizontal: col === "B" ? "center" : "left",
          wrapText: true,
        };
        // Keep monospace on a filename cell that wasn't set via rich text.
        if (col === "C" && !filenameChanged) cell.font = MONO;
      }
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
