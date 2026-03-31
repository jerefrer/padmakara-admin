import { generatePresignedDownloadUrl } from "../services/s3.ts";

interface TeacherDbRecord {
  id: number;
  name: string;
  abbreviation: string;
  photoUrl: string | null;
  avatarS3Key: string | null;
  heroS3Key: string | null;
  avatarUpdatedAt: Date | null;
  heroUpdatedAt: Date | null;
}

export interface TeacherResponse {
  id: number;
  name: string;
  abbreviation: string;
  avatarUrl: string | null;
  heroUrl: string | null;
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
  const avatarUrl = teacher.avatarS3Key
    ? await generatePresignedDownloadUrl(teacher.avatarS3Key)
    : teacher.photoUrl || null;

  const heroUrl = teacher.heroS3Key
    ? await generatePresignedDownloadUrl(teacher.heroS3Key)
    : null;

  return {
    id: teacher.id,
    name: teacher.name,
    abbreviation: teacher.abbreviation,
    avatarUrl,
    heroUrl,
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
