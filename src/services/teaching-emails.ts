import { renderBrandEmail, type Lang } from "./email-template.ts";

const KICKER: Record<Lang, string> = { en: "Your recordings", pt: "As suas gravações" };
const APP_URL = "https://app.padmakara.pt";

function greeting(lang: Lang, firstName: string | null | undefined): string {
  const name = firstName?.trim();
  if (name) return `${lang === "pt" ? "Olá" : "Dear"} ${name},`;
  return lang === "pt" ? "Olá," : "Hello,";
}

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
    second = pt
      ? "Estão na sua conta em app.padmakara.pt e na aplicação Padmakara. Inicie sessão com este endereço de email."
      : "They are in your account on app.padmakara.pt and in the Padmakara app. Sign in with this email address.";
  } else {
    second = pt
      ? "Avisamos assim que estiverem disponíveis online."
      : "We'll let you know as soon as they are online.";
  }

  const button = p.published
    ? { label: pt ? "Abrir a Padmakara" : "Open Padmakara", href: APP_URL }
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
