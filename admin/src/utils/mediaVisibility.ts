import type { DataProvider } from "react-admin";

/** The per-section "show in app" flags of an event (see the API's media-visibility service). */
export type SectionVisibilityKey =
  | "audioPublished"
  | "videoPublished"
  | "transcriptsPublished"
  | "textsPublished"
  | "topicsPublished";

export type MediaKind = "audio" | "video" | "transcripts" | "texts" | "topics";

const FLAG_OF_KIND: Record<MediaKind, SectionVisibilityKey> = {
  audio: "audioPublished",
  video: "videoPublished",
  transcripts: "transcriptsPublished",
  texts: "textsPublished",
  topics: "topicsPublished",
};

type EventSectionFlags = { status?: string } & { [K in SectionVisibilityKey]?: boolean | null };

/**
 * Whether an event has this section switched off in the app. Only meaningful while the
 * event is published: a draft is hidden whole, so its flags say nothing.
 */
export function isMediaHiddenInApp(event: EventSectionFlags, kind: MediaKind): boolean {
  if (event.status !== "published") return false;
  return event[FLAG_OF_KIND[kind]] === false;
}

/** Save one visibility flag on its own, as the Draft / Published toggle saves the status. */
export function saveMediaVisibility(
  dataProvider: Pick<DataProvider, "update">,
  id: number | string,
  previousData: Record<string, unknown> | undefined,
  key: SectionVisibilityKey,
  value: boolean,
): Promise<unknown> {
  return dataProvider.update("events", { id, data: { [key]: value }, previousData });
}
