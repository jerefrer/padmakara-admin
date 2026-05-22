import * as XLSX from "xlsx";

/** One row of the review spreadsheet — original vs corrected, side by side. */
export interface TrackExportRow {
  session: string;
  trackNumber: number | string;
  originalFilename: string;
  correctedFilename: string;
  originalTitle: string;
  correctedTitle: string;
  changes: string;
}

const HEADERS: Record<keyof TrackExportRow, string> = {
  session: "Session",
  trackNumber: "#",
  originalFilename: "Original filename",
  correctedFilename: "Corrected filename",
  originalTitle: "Original title",
  correctedTitle: "Corrected title",
  changes: "What changed",
};

/**
 * Build and download an .xlsx of the tracks for human review. A real Excel
 * file (not CSV) so accents and columns render correctly for a non-technical
 * reviewer regardless of their locale.
 */
export function exportTracksToXlsx(rows: TrackExportRow[], filename: string): void {
  const aoa: (string | number)[][] = [
    Object.values(HEADERS),
    ...rows.map((r) => [
      r.session,
      r.trackNumber,
      r.originalFilename,
      r.correctedFilename,
      r.originalTitle,
      r.correctedTitle,
      r.changes,
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Reasonable column widths (in characters).
  ws["!cols"] = [
    { wch: 22 }, // session
    { wch: 5 }, // #
    { wch: 46 }, // original filename
    { wch: 46 }, // corrected filename
    { wch: 38 }, // original title
    { wch: 38 }, // corrected title
    { wch: 34 }, // changes
  ];
  // Freeze the header row.
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Tracks");
  XLSX.writeFile(wb, filename);
}
