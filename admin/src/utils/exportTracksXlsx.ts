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

const RED = "FFB00020"; // original / removed
const GREEN = "FF2E7D32"; // corrected / added
const HEADER_BG = "FF5B5EA6"; // brand-ish indigo
const THIN = { style: "thin" as const, color: { argb: "FFD0D0D0" } };

/**
 * Build and download a styled .xlsx for human review. Each track spans two
 * rows: the original value on top, the corrected value below. Changed fields
 * are coloured (original red, corrected green); unchanged fields are merged
 * into a single cell. Session / # / comment cells are merged across the two
 * rows so each track reads as one block.
 *
 * Uses exceljs (not SheetJS community) because only exceljs writes cell
 * styling — fonts, fills, colours — to .xlsx in its open-source build.
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
      ws.getCell(`C${tr}`).value = r.originalFilename;
      ws.getCell(`C${tr}`).font = { color: { argb: RED }, strike: true };
      ws.getCell(`C${br}`).value = r.correctedFilename;
      ws.getCell(`C${br}`).font = { color: { argb: GREEN }, bold: true };
    } else {
      ws.mergeCells(`C${tr}:C${br}`);
      ws.getCell(`C${tr}`).value = r.originalFilename;
    }

    if (titleChanged) {
      ws.getCell(`D${tr}`).value = r.originalTitle;
      ws.getCell(`D${tr}`).font = { color: { argb: RED }, strike: true };
      ws.getCell(`D${br}`).value = r.correctedTitle;
      ws.getCell(`D${br}`).font = { color: { argb: GREEN }, bold: true };
    } else {
      ws.mergeCells(`D${tr}:D${br}`);
      ws.getCell(`D${tr}`).value = r.originalTitle;
    }

    // Shared formatting for both rows of the block.
    for (const rowNum of [tr, br]) {
      for (const col of ["A", "B", "C", "D", "E"]) {
        const cell = ws.getCell(`${col}${rowNum}`);
        cell.border = { top: THIN, bottom: THIN, left: THIN, right: THIN };
        cell.alignment = {
          vertical: col === "A" || col === "B" || col === "E" ? "middle" : "top",
          horizontal: col === "B" ? "center" : "left",
          wrapText: true,
        };
        if (col === "C") cell.font = { ...(cell.font ?? {}), name: "Menlo", size: 10 };
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
