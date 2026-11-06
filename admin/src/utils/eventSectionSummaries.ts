/** The one-line summaries of the event page's collapsed sections. */

interface Named {
  nameEn: string;
  namePt?: string | null;
}

type Translate = (key: string, options?: { smart_count?: number }) => string;

const localeName = (entity: Named, locale: string): string =>
  locale === "pt" && entity.namePt ? entity.namePt : entity.nameEn;

export function detailsSummary({
  eventType,
  groups,
  dateRange,
  teachers,
  locale,
}: {
  eventType: (Named & { abbreviation?: string | null }) | null;
  groups: Named[];
  dateRange: string;
  teachers: { name: string }[];
  locale: string;
}): string {
  return [
    eventType ? `${localeName(eventType, locale)} (${eventType.abbreviation})` : "",
    groups.map((group) => localeName(group, locale)).join(", "),
    dateRange,
    teachers.map((teacher) => teacher.name).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function readAlongTrackCount(
  sessions: { tracks?: { readAlongS3Key?: string | null }[] }[] | undefined,
): number {
  return (sessions ?? []).reduce(
    (sum, session) => sum + (session.tracks ?? []).filter((track) => !!track.readAlongS3Key).length,
    0,
  );
}

export function transcriptionSummary({
  transcriptCount,
  readAlongTracks,
  translate,
}: {
  transcriptCount: number;
  readAlongTracks: number;
  translate: Translate;
}): string {
  const parts = [
    transcriptCount > 0 ? translate("padmakara.eventSections.transcriptsSummary", { smart_count: transcriptCount }) : "",
    readAlongTracks > 0 ? translate("padmakara.eventSections.readAlongSummary", { smart_count: readAlongTracks }) : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : translate("padmakara.eventSections.nothingYet");
}
