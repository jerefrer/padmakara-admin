import { generatePresignedDownloadUrl } from "../services/s3.ts";

interface TeacherDbRecord {
  id: number;
  name: string;
  abbreviation: string;
  photoUrl: string | null;
  avatarS3Key: string | null;
  heroS3Key: string | null;
  heroMobileS3Key: string | null;
  heroFocalX: number;
  heroFocalY: number;
  heroScale: number;
  avatarUpdatedAt: Date | null;
  heroUpdatedAt: Date | null;
}

export interface TeacherResponse {
  id: number;
  name: string;
  abbreviation: string;
  avatarUrl: string | null;
  /** Desktop hero (2400px wide) — apps fall back to this on small screens
   *  if heroMobileUrl is missing (e.g., for legacy records uploaded before
   *  the variant rollout). */
  heroUrl: string | null;
  /** Mobile hero variant (1200px wide); preferred by phone-sized clients. */
  heroMobileUrl: string | null;
  heroFocalX: number;
  heroFocalY: number;
  heroScale: number;
  avatarUpdatedAt: string | null;
  heroUpdatedAt: string | null;
}

/**
 * Resolve teacher DB record to API response shape.
 * Converts S3 keys to presigned download URLs.
 * Falls back to photoUrl for avatar if no S3 key.
 */
export async function resolveTeacherUrls(
  teacher: TeacherDbRecord,
): Promise<TeacherResponse> {
  const [avatarUrl, heroUrl, heroMobileUrl] = await Promise.all([
    teacher.avatarS3Key
      ? generatePresignedDownloadUrl(teacher.avatarS3Key)
      : Promise.resolve(teacher.photoUrl || null),
    teacher.heroS3Key
      ? generatePresignedDownloadUrl(teacher.heroS3Key)
      : Promise.resolve(null),
    teacher.heroMobileS3Key
      ? generatePresignedDownloadUrl(teacher.heroMobileS3Key)
      : Promise.resolve(null),
  ]);

  return {
    id: teacher.id,
    name: teacher.name,
    abbreviation: teacher.abbreviation,
    avatarUrl,
    heroUrl,
    heroMobileUrl,
    heroFocalX: teacher.heroFocalX ?? 50,
    heroFocalY: teacher.heroFocalY ?? 50,
    heroScale: teacher.heroScale ?? 100,
    avatarUpdatedAt: teacher.avatarUpdatedAt?.toISOString() || null,
    heroUpdatedAt: teacher.heroUpdatedAt?.toISOString() || null,
  };
}

/**
 * Transform eventTeachers in an event object, resolving S3 keys to presigned URLs.
 * Mutates the event in-place for performance.
 */
export async function resolveEventTeacherUrls(event: any): Promise<void> {
  if (!event?.eventTeachers?.length) return;
  const resolved = await Promise.all(
    event.eventTeachers.map(async (et: any) => ({
      ...et,
      teacher: et.teacher ? await resolveTeacherUrls(et.teacher) : et.teacher,
    })),
  );
  event.eventTeachers = resolved;
}

/**
 * Batch-resolve teacher URLs for an array of events.
 */
export async function resolveEventsTeacherUrls(events: any[]): Promise<void> {
  await Promise.all(events.map(resolveEventTeacherUrls));
}
