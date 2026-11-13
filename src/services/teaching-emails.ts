import { renderBrandEmail, type Lang } from "./email-template.ts";
import { ANNOUNCEMENT_KINDS, type AnnouncementKind } from "../lib/announcement-kinds.ts";

const KICKER: Record<Lang, string> = { en: "Your recordings", pt: "As suas gravações" };
const APP_URL = "https://app.padmakara.pt";

function greeting(lang: Lang, firstName: string | null | undefined): string {
  const name = firstName?.trim();
  if (name) return `${lang === "pt" ? "Olá" : "Dear"} ${name},`;
  return lang === "pt" ? "Olá," : "Hello,";
}

const PUBLISHED_ACCESS: Record<Lang, string> = {
  pt: "Estão na sua conta em app.padmakara.pt e na aplicação Padmakara. Inicie sessão com este endereço de email.",
  en: "They are in your account on app.padmakara.pt and in the Padmakara app. Sign in with this email address.",
};
const OPEN_BUTTON: Record<Lang, string> = { pt: "Abrir a Padmakara", en: "Open Padmakara" };

/** The event's page: on a phone with the app installed it opens the app there (app links). */
const eventUrl = (eventId: number): string => `${APP_URL}/retreat/${eventId}`;

/** Sent once access to a single teaching is granted (purchase, free or manual). */
export function buildTeachingAvailableEmail(p: {
  lang: Lang;
  firstName?: string | null;
  eventId: number;
  eventTitle: string;
  published: boolean;
}): { subject: string; html: string; text: string } {
  const pt = p.lang === "pt";
  const subject = pt
    ? `As suas gravações: ${p.eventTitle}`
    : `Your recordings: ${p.eventTitle}`;

  const intro = pt
    ? `Tem agora acesso às gravações de ${p.eventTitle}.`
    : `You now have access to the recordings of ${p.eventTitle}.`;

  let second: string;
  if (p.published) {
    second = PUBLISHED_ACCESS[p.lang];
  } else {
    second = pt
      ? "Avisamos assim que estiverem disponíveis online."
      : "We'll let you know as soon as they are online.";
  }

  const button = p.published
    ? { label: OPEN_BUTTON[p.lang], href: eventUrl(p.eventId) }
    : undefined;

  return {
    subject,
    ...renderBrandEmail({
      lang: p.lang,
      subject,
      kicker: KICKER[p.lang],
      greeting: greeting(p.lang, p.firstName),
      paragraphs: [intro, second],
      button,
    }),
  };
}

/**
 * Sent to everyone who has access when an event goes from forthcoming/draft to published
 * and the admin chooses to announce it. Same follow-up text and button as the
 * "you now have access" email, with a different opening.
 */
export function buildTeachingPublishedEmail(p: {
  lang: Lang;
  firstName?: string | null;
  eventId: number;
  eventTitle: string;
  /** A personal note from the admin, shown as its own paragraph after the intro. Plain text. */
  message?: string;
}): { subject: string; html: string; text: string } {
  const pt = p.lang === "pt";
  const subject = pt ? `Já disponível: ${p.eventTitle}` : `Now available: ${p.eventTitle}`;
  const intro = pt
    ? `As gravações de ${p.eventTitle} já estão disponíveis.`
    : `The recordings of ${p.eventTitle} are now available.`;

  return {
    subject,
    ...renderBrandEmail({
      lang: p.lang,
      subject,
      kicker: KICKER[p.lang],
      greeting: greeting(p.lang, p.firstName),
      // The template escapes every paragraph and turns line breaks into <br />
      paragraphs: [intro, p.message?.replace(/\r\n?/g, "\n").trim() ?? "", PUBLISHED_ACCESS[p.lang]],
      button: { label: OPEN_BUTTON[p.lang], href: eventUrl(p.eventId) },
    }),
  };
}

const KIND_PHRASE: Record<Lang, Record<AnnouncementKind, string>> = {
  en: { transcripts: "the transcripts", videos: "the videos with subtitles", texts: "the related texts" },
  pt: { transcripts: "as transcrições", videos: "os vídeos com legendas", texts: "os textos relacionados" },
};

/** "a, b and c" in the reader's language, kinds always in the same order. */
function joinKinds(lang: Lang, kinds: AnnouncementKind[]): string {
  const items = ANNOUNCEMENT_KINDS.filter((k) => kinds.includes(k)).map((k) => KIND_PHRASE[lang][k]);
  const and = lang === "pt" ? "e" : "and";
  const list = items.length > 1 ? `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}` : (items[0] ?? "");
  return list.charAt(0).toUpperCase() + list.slice(1);
}

/**
 * Second email of an event: sent when its transcripts, videos with subtitles and/or related
 * texts are ready. Same access paragraph and button as the "recordings available" email.
 */
export function buildContentAnnouncementEmail(p: {
  lang: Lang;
  firstName?: string | null;
  eventId: number;
  eventTitle: string;
  kinds: AnnouncementKind[];
  /** A personal note from the admin, shown as its own paragraph after the intro. Plain text. */
  message?: string;
}): { subject: string; html: string; text: string } {
  const pt = p.lang === "pt";
  const subject = pt ? `Novidades: ${p.eventTitle}` : `New on ${p.eventTitle}`;
  const list = joinKinds(p.lang, p.kinds);
  const intro = pt
    ? `${list} de ${p.eventTitle} já estão disponíveis.`
    : `${list} of ${p.eventTitle} are now available.`;

  return {
    subject,
    ...renderBrandEmail({
      lang: p.lang,
      subject,
      kicker: KICKER[p.lang],
      greeting: greeting(p.lang, p.firstName),
      paragraphs: [intro, p.message?.replace(/\r\n?/g, "\n").trim() ?? "", PUBLISHED_ACCESS[p.lang]],
      button: { label: OPEN_BUTTON[p.lang], href: eventUrl(p.eventId) },
    }),
  };
}
