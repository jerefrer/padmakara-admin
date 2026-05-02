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
  "avatarS3Key" | "heroS3Key" | "avatarUpdatedAt" | "heroUpdatedAt" | "createdAt" | "updatedAt"
> {
  avatarS3Key: string | null;
  heroS3Key: string | null;
  avatarUrl: string | null;
  heroUrl: string | null;
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
  const avatarUrl = group.avatarS3Key
    ? await generatePresignedDownloadUrl(group.avatarS3Key)
    : group.logoUrl || null;

  const heroUrl = group.heroS3Key
    ? await generatePresignedDownloadUrl(group.heroS3Key)
    : null;

  return {
    ...group,
    avatarUrl,
    heroUrl,
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
