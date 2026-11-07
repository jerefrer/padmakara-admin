import type { DataProvider } from "react-admin";
import type { MediaVisibilityKey } from "../components/EventStatusControls";

export type MediaKind = "audio" | "video";

interface EventMediaFlags {
  status?: string;
  audioPublished?: boolean | null;
  videoPublished?: boolean | null;
}

/**
 * Whether an event has this media switched off in the app. Only meaningful while the
 * event is published: a draft is hidden whole, so its flags say nothing.
 */
export function isMediaHiddenInApp(event: EventMediaFlags, kind: MediaKind): boolean {
  if (event.status !== "published") return false;
  return (kind === "audio" ? event.audioPublished : event.videoPublished) === false;
}

/** Save one media flag on its own, as the Draft / Published toggle saves the status. */
export function saveMediaVisibility(
  dataProvider: Pick<DataProvider, "update">,
  id: number | string,
  previousData: Record<string, unknown> | undefined,
  key: MediaVisibilityKey,
  value: boolean,
): Promise<unknown> {
  return dataProvider.update("events", { id, data: { [key]: value }, previousData });
}
