export type AnnounceKind = "transcripts" | "videos" | "texts";

/** What GET /events/:id/announcements returns. */
export interface AnnouncementsInfo {
  recipients: number;
  /** The recordings email, or null if it was not sent. */
  published: { at: string; count: number } | null;
  kinds: Array<{
    kind: AnnounceKind;
    available: boolean;
    reason?: "hidden" | "empty";
    /** ISO date of the latest announcement naming this kind, or null. */
    announcedAt: string | null;
  }>;
  history: Array<{ kinds: AnnounceKind[]; sentAt: string; count: number; message: string | null }>;
}

export type Ticked = Partial<Record<AnnounceKind, boolean>>;

/** Available kinds not announced yet start ticked; an announced one is still tickable, unticked. */
export function defaultTicked(info: AnnouncementsInfo): Record<AnnounceKind, boolean> {
  const ticked = { transcripts: false, videos: false, texts: false };
  for (const k of info.kinds) ticked[k.kind] = k.available && !k.announcedAt;
  return ticked;
}

/** JSON body of POST /events/:id/announce. `force` only when re-sending an announced kind. */
export function announceBody(
  info: AnnouncementsInfo,
  ticked: Ticked,
  message: string,
): { kinds: AnnounceKind[]; message?: string; force?: true } {
  const chosen = info.kinds.filter((k) => k.available && ticked[k.kind]);
  const note = message.trim();
  return {
    kinds: chosen.map((k) => k.kind),
    ...(note ? { message: note } : {}),
    ...(chosen.some((k) => k.announcedAt) ? { force: true as const } : {}),
  };
}
