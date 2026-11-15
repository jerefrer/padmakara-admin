import { generatePresignedDownloadUrl } from "../services/s3.ts";
import { config } from "../config.ts";
import type { HeroFrameOverrides } from "../db/schema/teachers.ts";

/**
 * The optional photo of an event (e.g. several teachers together). Same model as a retreat
 * group's images: when present it replaces the teachers' photos wherever the event is shown.
 */

/** The image columns of an event row (all optional so partial rows from queries still resolve). */
export interface EventImageRecord {
  id?: number;
  status?: string | null;
  avatarS3Key?: string | null;
  heroS3Key?: string | null;
  heroMobileS3Key?: string | null;
  heroFocalX?: number | null;
  heroFocalY?: number | null;
  heroScale?: number | null;
  heroFrameOverrides?: HeroFrameOverrides | null;
  avatarUpdatedAt?: Date | string | null;
  heroUpdatedAt?: Date | string | null;
}

/** What the apps receive as `event.image`; null when the event has no photo. */
export interface EventImage {
  avatarUrl: string | null;
  /** Desktop hero (2400px wide). */
  heroUrl: string | null;
  /** Mobile hero variant (1200px wide); preferred by phone-sized clients. */
  heroMobileUrl: string | null;
  heroFocalX: number;
  heroFocalY: number;
  heroScale: number;
  /** Per-layout framing; null when every layout follows the focal point. */
  heroFrameOverrides: HeroFrameOverrides | null;
  avatarUpdatedAt: string | null;
  heroUpdatedAt: string | null;
  /** Square artwork for the lock screen / media notification (public URL, see event-artwork route). */
  artworkUrl: string | null;
}

/** Columns that never reach the apps: S3 keys and the re-edit state the admin keeps. */
const INTERNAL_COLUMNS = [
  "avatarS3Key",
  "heroS3Key",
  "heroMobileS3Key",
  "heroFocalX",
  "heroFocalY",
  "heroScale",
  "heroOriginalS3Key",
  "heroCrop",
  "heroGrayscale",
  "heroFrameOverrides",
  "avatarUpdatedAt",
  "heroUpdatedAt",
] as const;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Absolute URL of the event photo's square artwork, or null without a hero image. The `v` query
 * changes with the image and its framing, so the long cache of the artwork route is safe.
 */
export function eventArtworkUrl(event: EventImageRecord | null | undefined): string | null {
  if (!event?.heroS3Key || event.id == null) return null;
  const updated = event.heroUpdatedAt ? new Date(event.heroUpdatedAt).getTime() : 0;
  const base = config.urls.backend.replace(/\/+$/, "");
  return `${base}/api/events/${event.id}/artwork.jpg?v=${updated}`;
}

/** Resolve an event row's photo columns to presigned URLs. Null when it has no photo. */
export async function resolveEventImage(event: EventImageRecord): Promise<EventImage | null> {
  if (!event.avatarS3Key && !event.heroS3Key && !event.heroMobileS3Key) return null;
  const sign = (key: string | null | undefined) => (key ? generatePresignedDownloadUrl(key) : Promise.resolve(null));
  const [avatarUrl, heroUrl, heroMobileUrl] = await Promise.all([
    sign(event.avatarS3Key),
    sign(event.heroS3Key),
    sign(event.heroMobileS3Key),
  ]);
  return {
    avatarUrl,
    heroUrl,
    heroMobileUrl,
    heroFocalX: event.heroFocalX ?? 50,
    heroFocalY: event.heroFocalY ?? 50,
    heroScale: event.heroScale ?? 100,
    heroFrameOverrides: event.heroFrameOverrides ?? null,
    avatarUpdatedAt: iso(event.avatarUpdatedAt),
    heroUpdatedAt: iso(event.heroUpdatedAt),
    artworkUrl: eventArtworkUrl(event),
  };
}

/**
 * Public payloads: set `event.image` (null without a photo) and drop the raw photo columns.
 * Mutates in place, like the teacher and group resolvers. Run it after anything that still
 * needs the raw columns (e.g. the track artwork enrichment).
 */
export async function resolveEventImageUrls(event: any): Promise<void> {
  if (!event) return;
  event.image = await resolveEventImage(event);
  for (const column of INTERNAL_COLUMNS) delete event[column];
}

export async function resolveEventsImageUrls(events: any[]): Promise<void> {
  await Promise.all(events.map(resolveEventImageUrls));
}

/**
 * Admin payloads: the same flat fields a group record has (avatarUrl, heroUrl, heroMobileUrl),
 * so the shared image editor reads both. The raw columns stay: the editor needs the stored
 * original and crop to re-open a photo as it was saved.
 */
export async function adminEventImageFields(
  event: EventImageRecord,
): Promise<{ avatarUrl: string | null; heroUrl: string | null; heroMobileUrl: string | null }> {
  const image = await resolveEventImage(event);
  return {
    avatarUrl: image?.avatarUrl ?? null,
    heroUrl: image?.heroUrl ?? null,
    heroMobileUrl: image?.heroMobileUrl ?? null,
  };
}
