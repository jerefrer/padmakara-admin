import { generatePresignedDownloadUrl } from "../services/s3.ts";

interface RetreatGroupDbRecord {
  id: number;
  nameEn: string;
  namePt: string | null;
  abbreviation: string | null;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  avatarS3Key: string | null;
  heroS3Key: string | null;
  heroMobileS3Key: string | null;
  heroFocalX: number;
  heroFocalY: number;
  heroScale: number;
  avatarUpdatedAt: Date | null;
  heroUpdatedAt: Date | null;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RetreatGroupResponse extends Omit<
  RetreatGroupDbRecord,
  "avatarS3Key" | "heroS3Key" | "heroMobileS3Key" | "avatarUpdatedAt" | "heroUpdatedAt" | "createdAt" | "updatedAt"
> {
  avatarS3Key: string | null;
  heroS3Key: string | null;
  heroMobileS3Key: string | null;
  avatarUrl: string | null;
  /** Desktop hero (2400px wide). */
  heroUrl: string | null;
  /** Mobile hero variant (1200px wide); preferred by phone-sized clients. */
  heroMobileUrl: string | null;
  avatarUpdatedAt: string | null;
  heroUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Resolve retreat-group DB record to API response shape.
 * Converts S3 keys to presigned download URLs.
 * Falls back to logoUrl for the avatar if no S3 key.
 */
export async function resolveGroupUrls(
  group: RetreatGroupDbRecord,
): Promise<RetreatGroupResponse> {
  const [avatarUrl, heroUrl, heroMobileUrl] = await Promise.all([
    group.avatarS3Key
      ? generatePresignedDownloadUrl(group.avatarS3Key)
      : Promise.resolve(group.logoUrl || null),
    group.heroS3Key
      ? generatePresignedDownloadUrl(group.heroS3Key)
      : Promise.resolve(null),
    group.heroMobileS3Key
      ? generatePresignedDownloadUrl(group.heroMobileS3Key)
      : Promise.resolve(null),
  ]);

  return {
    ...group,
    avatarUrl,
    heroUrl,
    heroMobileUrl,
    heroFocalX: group.heroFocalX ?? 50,
    heroFocalY: group.heroFocalY ?? 50,
    heroScale: group.heroScale ?? 100,
    avatarUpdatedAt: group.avatarUpdatedAt?.toISOString() || null,
    heroUpdatedAt: group.heroUpdatedAt?.toISOString() || null,
    createdAt: group.createdAt instanceof Date ? group.createdAt.toISOString() : (group.createdAt as any),
    updatedAt: group.updatedAt instanceof Date ? group.updatedAt.toISOString() : (group.updatedAt as any),
  };
}

/**
 * Resolve a list of group records.
 */
export async function resolveGroupsUrls(
  groups: RetreatGroupDbRecord[],
): Promise<RetreatGroupResponse[]> {
  return Promise.all(groups.map(resolveGroupUrls));
}

/**
 * Mutate event.eventRetreatGroups in place, replacing each nested
 * retreatGroup with its resolved (presigned-URL) shape.
 */
export async function resolveEventGroupUrls(event: any): Promise<void> {
  if (!event?.eventRetreatGroups?.length) return;
  const resolved = await Promise.all(
    event.eventRetreatGroups.map(async (erg: any) => ({
      ...erg,
      retreatGroup: erg.retreatGroup ? await resolveGroupUrls(erg.retreatGroup) : erg.retreatGroup,
    })),
  );
  event.eventRetreatGroups = resolved;
}

/**
 * Batch-resolve group URLs across an array of events.
 */
export async function resolveEventsGroupUrls(events: any[]): Promise<void> {
  await Promise.all(events.map(resolveEventGroupUrls));
}
