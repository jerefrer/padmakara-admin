/** One teaching in GET /api/admin/statistics (totals for the selected period). */
export interface EventRow {
  id: number;
  title: string;
  titlePt: string | null;
  startDate: string | null;
  endDate: string | null;
  listeners: number;
  completedTracks: number;
  listenHours: number;
  videoViewers: number;
  transcriptOpens: number;
  readAlongOpens: number;
  fileOpens: number;
  videoStarts: number;
  zipDownloads: number;
  videoDownloads: number;
}

export interface DateRange {
  from: string;
  to: string;
}

/** GET /api/admin/statistics/events/:id */
export interface TeachingDetail {
  range: DateRange;
  /** First day per-item opens and plays were recorded; null until the first one. */
  itemsRecordedFrom: string | null;
  event: { id: number; title: string; titlePt: string | null; startDate: string | null; endDate: string | null };
  tracks: {
    id: number;
    title: string;
    trackNumber: number;
    sessionNumber: number;
    sessionTitle: string | null;
    listeners: number;
    completions: number;
    listenHours: number;
  }[];
  videos: { id: number; title: string | null; titlePt: string | null; position: number; viewers: number; plays: number }[];
  documents: { id: number; title: string | null; filename: string; opens: number }[];
  transcripts: { id: number; language: string; filename: string | null; opens: number }[];
}
