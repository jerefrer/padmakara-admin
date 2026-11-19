import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { publications } from "../db/schema/publications.ts";
import { transcripts } from "../db/schema/transcripts.ts";
import { users } from "../db/schema/users.ts";
import type { ReaderDocumentType } from "../db/schema/reader-state.ts";
import { filterAccessibleEvents } from "./access.ts";
import { contentVisibleTo, transcriptFileVisibleTo } from "./media-visibility.ts";
import { openablePublications } from "./publication-access.ts";
import { publicationStatusOpenTo } from "./publication-status.ts";

/**
 * Which reader documents (publications and transcripts) a caller can open, by
 * the same rules as the routes that serve their PDF:
 *
 * - publication: GET /api/publications/:id/pdf, i.e. a status whose file the
 *   caller may open (`publicationStatusOpenTo`) and `openablePublications`.
 * - transcript: GET /api/media/transcript/:id, i.e. the event's access rule
 *   (status and audience, `checkEventAccess` through `filterAccessibleEvents`),
 *   the event's transcripts section and the file's own `published` switch. A
 *   transcript without an event is open to any signed-in caller, as there.
 *
 * The reader state routes call this before storing or returning anything, so a
 * caller who cannot open a document can neither keep state for it nor learn
 * that it exists. It also gives the titles the "My Bookmarks" list shows.
 */

export interface ReaderDocumentRef {
  type: ReaderDocumentType;
  id: number;
}

export type ReaderDocumentInfo =
  | { type: "publication"; id: number; title: string }
  | {
      type: "transcript";
      id: number;
      language: string;
      event: { id: number; titleEn: string | null; titlePt: string | null } | null;
    };

export function readerDocumentKey(type: ReaderDocumentType, id: number): string {
  return `${type}:${id}`;
}

interface Caller {
  id: number;
  role: string;
}

async function openPublications(caller: Caller, ids: number[]): Promise<ReaderDocumentInfo[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(publications).where(inArray(publications.id, ids));
  const openStatuses = publicationStatusOpenTo(caller.role);
  const candidates = rows.filter((p) => openStatuses.includes(p.status));
  const opened = await openablePublications(caller, candidates);
  return candidates
    .filter((p) => opened.has(p.id))
    .map((p) => ({ type: "publication" as const, id: p.id, title: p.title }));
}

async function openTranscripts(caller: Caller, ids: number[]): Promise<ReaderDocumentInfo[]> {
  if (ids.length === 0) return [];
  const rows = await db.query.transcripts.findMany({
    where: inArray(transcripts.id, ids),
    with: { event: { with: { audience: true } } },
  });
  const candidates = rows.filter((row) => !!row.s3Key && transcriptFileVisibleTo(row, caller.role));

  const user = await db.query.users.findFirst({ where: eq(users.id, caller.id) });
  if (!user) return [];
  const events = new Map<number, NonNullable<(typeof candidates)[number]["event"]>>();
  for (const row of candidates) if (row.event) events.set(row.event.id, row.event);
  const openEvents = new Set(
    (
      await filterAccessibleEvents(
        {
          id: user.id,
          role: user.role,
          subscriptionStatus: user.subscriptionStatus,
          subscriptionExpiresAt: user.subscriptionExpiresAt,
        },
        [...events.values()],
      )
    ).map((event) => event.id),
  );

  return candidates
    .filter((row) => !row.event || (openEvents.has(row.event.id) && contentVisibleTo(row.event, caller.role).transcripts))
    .map((row) => ({
      type: "transcript" as const,
      id: row.id,
      language: row.language,
      event: row.event ? { id: row.event.id, titleEn: row.event.titleEn, titlePt: row.event.titlePt } : null,
    }));
}

/** The documents among `refs` that the caller can open, keyed by `readerDocumentKey`. */
export async function openableReaderDocuments(
  caller: Caller,
  refs: ReaderDocumentRef[],
): Promise<Map<string, ReaderDocumentInfo>> {
  const idsOf = (type: ReaderDocumentType) => [...new Set(refs.filter((r) => r.type === type).map((r) => r.id))];
  const [pubs, trans] = await Promise.all([
    openPublications(caller, idsOf("publication")),
    openTranscripts(caller, idsOf("transcript")),
  ]);
  return new Map([...pubs, ...trans].map((doc) => [readerDocumentKey(doc.type, doc.id), doc]));
}

/** Whether the caller can open this one document. */
export async function canOpenReaderDocument(caller: Caller, ref: ReaderDocumentRef): Promise<boolean> {
  return (await openableReaderDocuments(caller, [ref])).has(readerDocumentKey(ref.type, ref.id));
}
