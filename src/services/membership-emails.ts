export type Lang = "en" | "pt";

/** "pt" gets Portuguese; anything else (including unknown or missing) gets English. */
export function emailLanguage(preferredLanguage: string | null | undefined): Lang {
  return preferredLanguage === "pt" ? "pt" : "en";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(date: Date, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === "pt" ? "pt-PT" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function button(url: string, label: string): string {
  return `<p><a href="${escapeHtml(url)}" style="display: inline-block; padding: 12px 24px; background: #9b1b1b; color: white; text-decoration: none; border-radius: 6px;">${escapeHtml(label)}</a></p>`;
}

function layout(lang: Lang, firstName: string | null, paragraphs: string[], buttons: string): string {
  const name = firstName?.trim();
  const greeting = name
    ? `${lang === "pt" ? "Olá" : "Dear"} ${escapeHtml(name)},`
    : lang === "pt"
      ? "Olá,"
      : "Hello,";
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Padmakara</h2>
      <p>${greeting}</p>
      ${paragraphs.map((p) => `<p>${p}</p>`).join("\n      ")}
      ${buttons}
    </div>
  `;
}

export function buildWelcomeEmail(p: {
  lang: Lang;
  firstName: string | null;
  amount: number;
  interval: "month" | "year";
  nextPaymentAt: Date;
  manageUrl: string;
  retreatsUrl: string;
}): { subject: string; html: string } {
  const date = formatDate(p.nextPaymentAt, p.lang);
  const amount = `€${p.amount}`;
  if (p.lang === "pt") {
    const per = p.interval === "year" ? "ano" : "mês";
    return {
      subject: "Bem-vindo à Padmakara",
      html: layout(
        "pt",
        p.firstName,
        [
          "Obrigado por se juntar à Padmakara. A sua adesão torna possível partilhar estes ensinamentos.",
          `A sua contribuição de ${amount} por ${per} é renovada automaticamente a ${date}. Pode alterá-la ou cancelá-la a qualquer momento na sua página de adesão.`,
        ],
        button(p.retreatsUrl, "Ir para os meus retiros") + button(p.manageUrl, "Gerir a minha adesão"),
      ),
    };
  }
  return {
    subject: "Welcome to Padmakara",
    html: layout(
      "en",
      p.firstName,
      [
        "Thank you for joining Padmakara. Your membership helps make these teachings available.",
        `Your contribution of ${amount} per ${p.interval} renews automatically on ${date}. You can change or cancel it at any time from your membership page.`,
      ],
      button(p.retreatsUrl, "Go to my retreats") + button(p.manageUrl, "Manage my membership"),
    ),
  };
}

export function buildPaymentFailedEmail(p: {
  lang: Lang;
  firstName: string | null;
  graceUntil: Date;
  updateUrl: string;
}): { subject: string; html: string } {
  const date = formatDate(p.graceUntil, p.lang);
  if (p.lang === "pt") {
    return {
      subject: "Não foi possível processar a sua contribuição Padmakara",
      html: layout(
        "pt",
        p.firstName,
        [
          "Não conseguimos processar a sua última contribuição.",
          `O seu acesso continua até ${date}. Atualize o seu método de pagamento para o manter.`,
        ],
        button(p.updateUrl, "Atualizar método de pagamento"),
      ),
    };
  }
  return {
    subject: "We couldn't take your Padmakara contribution",
    html: layout(
      "en",
      p.firstName,
      [
        "We were unable to process your latest contribution.",
        `Your access continues until ${date}. Update your payment method to keep it.`,
      ],
      button(p.updateUrl, "Update payment method"),
    ),
  };
}

export function buildCancelledEmail(p: {
  lang: Lang;
  firstName: string | null;
  accessUntil: Date;
  resumeUrl: string;
}): { subject: string; html: string } {
  const date = formatDate(p.accessUntil, p.lang);
  if (p.lang === "pt") {
    return {
      subject: `A sua adesão à Padmakara termina a ${date}`,
      html: layout(
        "pt",
        p.firstName,
        [
          "Cancelámos a sua adesão. Não serão efetuados mais pagamentos.",
          `Mantém o acesso até ${date}. Se mudar de ideias, pode retomá-la até essa data.`,
        ],
        button(p.resumeUrl, "Retomar a minha adesão"),
      ),
    };
  }
  return {
    subject: `Your Padmakara membership ends on ${date}`,
    html: layout(
      "en",
      p.firstName,
      [
        "We have cancelled your membership. No further payments will be taken.",
        `You keep your access until ${date}. If you change your mind, you can resume it before then.`,
      ],
      button(p.resumeUrl, "Resume my membership"),
    ),
  };
}

/** A first payment (no membership yet) was refused: nothing was charged, nothing started. */
export function buildFirstPaymentFailedEmail(p: {
  lang: Lang;
  firstName: string | null;
  joinUrl: string;
}): { subject: string; html: string } {
  if (p.lang === "pt") {
    return {
      subject: "O seu pagamento Padmakara não foi concluído",
      html: layout(
        "pt",
        p.firstName,
        [
          "Não foi possível concluir o seu pagamento. Nada foi cobrado e a sua adesão ainda não começou.",
          "Pode tentar novamente com outro cartão ou conta bancária.",
        ],
        button(p.joinUrl, "Tentar novamente"),
      ),
    };
  }
  return {
    subject: "Your Padmakara payment didn't go through",
    html: layout(
      "en",
      p.firstName,
      [
        "We could not complete your payment. Nothing was charged and your membership has not started.",
        "You can try again with another card or bank account.",
      ],
      button(p.joinUrl, "Try again"),
    ),
  };
}
