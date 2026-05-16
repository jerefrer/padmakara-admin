import { z } from "zod";

/** A single track within a proposed session structure. */
export interface ProposedTrack {
  importFileId: number;
  trackNumber: number;
  title: string;
  speaker: string | null;
  languages: string[];
  originalLanguage: string;
  isTranslation: boolean;
}

/** A session within a proposed structure. */
export interface ProposedSession {
  sessionNumber: number;
  titleEn: string;
  sessionDate: string | null;
  timePeriod: string;
  tracks: ProposedTrack[];
}

/** The full proposed (or human-confirmed) session structure for an import job. */
export interface ProposedStructure {
  sessions: ProposedSession[];
}

/**
 * Schema for the grouping the AI returns. The AI decides only which audio
 * files go in which session, plus the session metadata — per-track metadata
 * is derived deterministically by the caller, never by the AI.
 */
export const aiGroupingSchema = z.object({
  sessions: z
    .array(
      z.object({
        sessionNumber: z.number().int(),
        titleEn: z.string().min(1),
        sessionDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        timePeriod: z.enum(["morning", "afternoon", "evening"]).nullable(),
        importFileIds: z.array(z.number().int()).min(1),
      }),
    )
    .min(1),
});

export type AiGrouping = z.infer<typeof aiGroupingSchema>;

/**
 * Combine the AI's session grouping with deterministic per-track metadata
 * into a full proposed structure. Guarantees referential integrity: throws
 * if the grouping references an unknown file, places a file in more than one
 * session, or omits any file. Sessions are renumbered 1..N in the order the
 * AI returned them; a null session timePeriod defaults to "morning".
 */
export function assembleProposedStructure(
  grouping: AiGrouping,
  tracksByFileId: Map<number, ProposedTrack>,
): ProposedStructure {
  const seen = new Set<number>();

  const sessions: ProposedSession[] = grouping.sessions.map((group, index) => {
    const tracks: ProposedTrack[] = group.importFileIds.map((fileId) => {
      const track = tracksByFileId.get(fileId);
      if (!track) {
        throw new Error(
          `AI grouping references unknown import file id ${fileId}`,
        );
      }
      if (seen.has(fileId)) {
        throw new Error(
          `AI grouping places import file id ${fileId} in more than one session`,
        );
      }
      seen.add(fileId);
      return track;
    });
    return {
      sessionNumber: index + 1,
      titleEn: group.titleEn,
      sessionDate: group.sessionDate,
      timePeriod: group.timePeriod ?? "morning",
      tracks,
    };
  });

  for (const fileId of tracksByFileId.keys()) {
    if (!seen.has(fileId)) {
      throw new Error(`AI grouping omits import file id ${fileId}`);
    }
  }

  return { sessions };
}
