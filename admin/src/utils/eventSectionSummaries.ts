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

const filledLines = (en: string | null | undefined, pt: string | null | undefined): number =>
  Math.max(
    ...[en, pt].map((text) => (text ?? "").split("\n").filter((line) => line.trim() !== "").length),
  );

export function topicsSummary({
  mainThemesEn,
  mainThemesPt,
  sessionThemesEn,
  sessionThemesPt,
  translate,
}: {
  mainThemesEn?: string | null;
  mainThemesPt?: string | null;
  sessionThemesEn?: string | null;
  sessionThemesPt?: string | null;
  translate: Translate;
}): string {
  const main = filledLines(mainThemesEn, mainThemesPt);
  const session = filledLines(sessionThemesEn, sessionThemesPt);
  const parts = [
    main > 0 ? translate("padmakara.eventSections.mainTopicsSummary", { smart_count: main }) : "",
    session > 0 ? translate("padmakara.eventSections.sessionTopicsSummary", { smart_count: session }) : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : translate("padmakara.eventSections.noTopics");
}
