import { and, count, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { eventAnnouncements } from "../db/schema/event-announcements.ts";
import { eventFiles } from "../db/schema/event-files.ts";
import { eventPublications } from "../db/schema/publications.ts";
import { eventVideos } from "../db/schema/event-videos.ts";
import { sessions } from "../db/schema/sessions.ts";
import { tracks } from "../db/schema/tracks.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import type { AnnouncementKind } from "../lib/announcement-kinds.ts";

export type ContentCounts = Record<AnnouncementKind, number>;

export interface AnnouncementRecord {
  kinds: string[];
  message: string | null;
  recipientCount: number;
  sentAt: Date;
}

/**
 * How much of each announceable section an event holds, counted the way the app shows it:
 * transcripts = transcript PDFs + tracks with a read-along, videos = uploaded videos,
 * texts = event files + linked publications.
 */
export async function countAnnounceableContent(eventId: number): Promise<ContentCounts> {
  const [pdfs, readAlong, videos, files, publications] = await Promise.all([
    db.select({ n: count() }).from(transcripts).where(and(eq(transcripts.eventId, eventId), isNotNull(transcripts.s3Key))),
    db
      .select({ n: count() })
      .from(tracks)
      .innerJoin(sessions, eq(tracks.sessionId, sessions.id))
      .where(and(eq(sessions.eventId, eventId), isNotNull(tracks.readAlongS3Key))),
    db.select({ n: count() }).from(eventVideos).where(and(eq(eventVideos.eventId, eventId), isNotNull(eventVideos.bunnyVideoId))),
    db.select({ n: count() }).from(eventFiles).where(eq(eventFiles.eventId, eventId)),
    db.select({ n: count() }).from(eventPublications).where(eq(eventPublications.eventId, eventId)),
  ]);
  return {
    transcripts: (pdfs[0]?.n ?? 0) + (readAlong[0]?.n ?? 0),
    videos: videos[0]?.n ?? 0,
    texts: (files[0]?.n ?? 0) + (publications[0]?.n ?? 0),
  };
}

/** The "new content" emails already sent for an event, newest first. */
export async function listAnnouncements(eventId: number): Promise<AnnouncementRecord[]> {
  return db
    .select({
      kinds: eventAnnouncements.kinds,
      message: eventAnnouncements.message,
      recipientCount: eventAnnouncements.recipientCount,
      sentAt: eventAnnouncements.sentAt,
    })
    .from(eventAnnouncements)
    .where(eq(eventAnnouncements.eventId, eventId))
    .orderBy(desc(eventAnnouncements.sentAt), desc(eventAnnouncements.id));
}

export async function recordAnnouncement(row: {
  eventId: number;
  kinds: AnnouncementKind[];
  message: string | null;
  recipientCount: number;
  sentBy: number | null;
}): Promise<void> {
  await db.insert(eventAnnouncements).values(row);
}
