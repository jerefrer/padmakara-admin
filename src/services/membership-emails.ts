import { renderBrandEmail, type Lang } from "./email-template.ts";

export type { Lang };

/** "pt" gets Portuguese; anything else (including unknown or missing) gets English. */
export function emailLanguage(preferredLanguage: string | null | undefined): Lang {
  return preferredLanguage === "pt" ? "pt" : "en";
}

/** Every membership message wears the same kicker: they are one conversation. */
const KICKER: Record<Lang, string> = { en: "Membership", pt: "Adesão" };

function formatDate(date: Date, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === "pt" ? "pt-PT" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** "Dear Ana," — or, with no name to use, a greeting that does not need one. */
function greeting(lang: Lang, firstName: string | null): string {
  const name = firstName?.trim();
  if (name) return `${lang === "pt" ? "Olá" : "Dear"} ${name},`;
  return lang === "pt" ? "Olá," : "Hello,";
}

type Built = { subject: string; html: string; text: string };

/** Subject, then the shell. The subject is also the document title. */
function membershipEmail(p: {
  lang: Lang;
  subject: string;
  firstName: string | null;
  paragraphs: string[];
  button: { label: string; href: string };
  secondary?: { label: string; href: string };
}): Built {
  return {
    subject: p.subject,
    ...renderBrandEmail({
      lang: p.lang,
      subject: p.subject,
      kicker: KICKER[p.lang],
      greeting: greeting(p.lang, p.firstName),
      paragraphs: p.paragraphs,
      button: p.button,
      secondary: p.secondary,
    }),
  };
}

export function buildWelcomeEmail(p: {
  lang: Lang;
  firstName: string | null;
  amount: number;
  interval: "month" | "year";
  nextPaymentAt: Date;
  manageUrl: string;
  retreatsUrl: string;
}): Built {
  const date = formatDate(p.nextPaymentAt, p.lang);
  // Without a known amount, say nothing about it rather than "€0".
  const hasAmount = Number.isFinite(p.amount) && p.amount > 0;
  const amount = `€${p.amount}`;

  if (p.lang === "pt") {
    const per = p.interval === "year" ? "ano" : "mês";
    return membershipEmail({
      lang: "pt",
      subject: "Bem-vindo à Padmakara",
      firstName: p.firstName,
      paragraphs: [
        "Obrigado por se juntar à Padmakara. A sua adesão torna possível partilhar estes ensinamentos.",
        `A sua contribuição${hasAmount ? ` de ${amount} por ${per}` : ""} é renovada automaticamente a ${date}. Pode alterá-la ou cancelá-la a qualquer momento na sua página de adesão.`,
      ],
      button: { label: "Ir para os meus retiros", href: p.retreatsUrl },
      secondary: { label: "Gerir a minha adesão", href: p.manageUrl },
    });
  }

  return membershipEmail({
    lang: "en",
    subject: "Welcome to Padmakara",
    firstName: p.firstName,
    paragraphs: [
      "Thank you for joining Padmakara. Your membership helps make these teachings available.",
      `Your contribution${hasAmount ? ` of ${amount} per ${p.interval}` : ""} renews automatically on ${date}. You can change or cancel it at any time from your membership page.`,
    ],
    button: { label: "Go to my retreats", href: p.retreatsUrl },
    secondary: { label: "Manage my membership", href: p.manageUrl },
  });
}

export function buildPaymentFailedEmail(p: {
  lang: Lang;
  firstName: string | null;
  graceUntil: Date;
  updateUrl: string;
}): Built {
  const date = formatDate(p.graceUntil, p.lang);

  if (p.lang === "pt") {
    return membershipEmail({
      lang: "pt",
      subject: "Não foi possível processar a sua contribuição Padmakara",
      firstName: p.firstName,
      paragraphs: [
        "Não conseguimos processar a sua última contribuição.",
        `O seu acesso continua até ${date}. Atualize o seu método de pagamento para o manter.`,
      ],
      button: { label: "Atualizar método de pagamento", href: p.updateUrl },
    });
  }

  return membershipEmail({
    lang: "en",
    subject: "We couldn't take your Padmakara contribution",
    firstName: p.firstName,
    paragraphs: [
      "We were unable to process your latest contribution.",
      `Your access continues until ${date}. Update your payment method to keep it.`,
    ],
    button: { label: "Update payment method", href: p.updateUrl },
  });
}

export function buildCancelledEmail(p: {
  lang: Lang;
  firstName: string | null;
  accessUntil: Date;
  resumeUrl: string;
}): Built {
  const date = formatDate(p.accessUntil, p.lang);

  if (p.lang === "pt") {
    return membershipEmail({
      lang: "pt",
      subject: `A sua adesão à Padmakara termina a ${date}`,
      firstName: p.firstName,
      paragraphs: [
        "Cancelámos a sua adesão. Não serão efetuados mais pagamentos.",
        `Mantém o acesso até ${date}. Se mudar de ideias, pode retomá-la até essa data.`,
      ],
      button: { label: "Retomar a minha adesão", href: p.resumeUrl },
    });
  }

  return membershipEmail({
    lang: "en",
    subject: `Your Padmakara membership ends on ${date}`,
    firstName: p.firstName,
    paragraphs: [
      "We have cancelled your membership. No further payments will be taken.",
      `You keep your access until ${date}. If you change your mind, you can resume it before then.`,
    ],
    button: { label: "Resume my membership", href: p.resumeUrl },
  });
}

/** A first payment (no membership yet) was refused: nothing was charged, nothing started. */
export function buildFirstPaymentFailedEmail(p: {
  lang: Lang;
  firstName: string | null;
  joinUrl: string;
}): Built {
  if (p.lang === "pt") {
    return membershipEmail({
      lang: "pt",
      subject: "O seu pagamento Padmakara não foi concluído",
      firstName: p.firstName,
      paragraphs: [
        "Não foi possível concluir o seu pagamento. Nada foi cobrado e a sua adesão ainda não começou.",
        "Pode tentar novamente com outro cartão ou conta bancária.",
      ],
      button: { label: "Tentar novamente", href: p.joinUrl },
    });
  }

  return membershipEmail({
    lang: "en",
    subject: "Your Padmakara payment didn't go through",
    firstName: p.firstName,
    paragraphs: [
      "We could not complete your payment. Nothing was charged and your membership has not started.",
      "You can try again with another card or bank account.",
    ],
    button: { label: "Try again", href: p.joinUrl },
  });
}
