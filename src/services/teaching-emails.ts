import { renderBrandEmail, type Lang } from "./email-template.ts";

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

/** Sent once access to a single teaching is granted (purchase, free or manual). */
export function buildTeachingAvailableEmail(p: {
  lang: Lang;
  firstName?: string | null;
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
    ? { label: OPEN_BUTTON[p.lang], href: APP_URL }
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
  eventTitle: string;
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
      paragraphs: [intro, PUBLISHED_ACCESS[p.lang]],
      button: { label: OPEN_BUTTON[p.lang], href: APP_URL },
    }),
  };
}
