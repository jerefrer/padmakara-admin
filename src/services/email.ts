import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { config } from "../config.ts";
import { renderBrandEmail, type Lang } from "./email-template.ts";

const ses = new SESClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

/**
 * Send an email via AWS SES in production, or log to console in development.
 *
 * `text` is the plain-text twin of `html`. It is optional only so that a caller
 * that has not been converted yet still compiles; every email we send has one,
 * because HTML-only mail scores worse with spam filters and some readers see
 * nothing else.
 */
export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<void> {
  if (config.isDev) {
    console.log(`[EMAIL] To: ${options.to}`);
    console.log(`[EMAIL] Subject: ${options.subject}`);
    console.log(`[EMAIL] Body: ${options.text ?? options.html}`);
    return;
  }

  const command = new SendEmailCommand({
    Source: config.email.fromEmail,
    Destination: { ToAddresses: [options.to] },
    Message: {
      Subject: { Data: options.subject, Charset: "UTF-8" },
      Body: {
        Html: { Data: options.html, Charset: "UTF-8" },
        ...(options.text ? { Text: { Data: options.text, Charset: "UTF-8" } } : {}),
      },
    },
  });

  await ses.send(command);
  console.log(`[EMAIL] Sent to ${options.to}: ${options.subject}`);
}

/** "pt" gets Portuguese; anything else (including unknown or missing) gets English. */
function lang(language: string | null | undefined): Lang {
  return language === "pt" ? "pt" : "en";
}

export function buildMagicLinkEmail(
  magicLinkUrl: string,
  language: string,
  code?: string,
): { subject: string; html: string; text: string } {
  if (lang(language) === "pt") {
    return {
      subject: "O seu link de acesso - Padmakara",
      ...renderBrandEmail({
        lang: "pt",
        subject: "O seu link de acesso - Padmakara",
        kicker: "Acesso",
        paragraphs: ["Carregue no botão abaixo para aceder à sua conta."],
        note: code
          ? "Este link e este código expiram dentro de uma hora."
          : "Este link expira dentro de uma hora.",
        button: { label: "Aceder à minha conta", href: magicLinkUrl },
        ...(code
          ? { code: { intro: "Ou introduza este código na aplicação ou no site:", value: code } }
          : {}),
      }),
    };
  }

  return {
    subject: "Your login link - Padmakara",
    ...renderBrandEmail({
      lang: "en",
      subject: "Your login link - Padmakara",
      kicker: "Access",
      paragraphs: ["Click the button below to access your account."],
      note: code
        ? "This link and this code expire in one hour."
        : "This link expires in one hour.",
      button: { label: "Access my account", href: magicLinkUrl },
      ...(code
        ? { code: { intro: "Or enter this code in the app or on the website:", value: code } }
        : {}),
    }),
  };
}

export function buildAccountDeletionEmail(
  confirmUrl: string,
  language: string,
): { subject: string; html: string; text: string } {
  if (lang(language) === "pt") {
    return {
      subject: "Confirme a eliminação da sua conta - Padmakara",
      ...renderBrandEmail({
        lang: "pt",
        subject: "Confirme a eliminação da sua conta - Padmakara",
        kicker: "Conta",
        paragraphs: [
          "Recebemos um pedido para eliminar a sua conta Padmakara. Se foi você, carregue no botão abaixo para confirmar. A sua conta e os seus dados pessoais (progresso, marcadores, dispositivos) serão eliminados de forma permanente. Os registos de pagamentos são conservados apenas para fins de contabilidade, como a lei exige.",
          "Se não fez este pedido, ignore este email: nada será eliminado.",
        ],
        note: "Este link expira dentro de uma hora.",
        button: { label: "Continuar para a eliminação", href: confirmUrl },
      }),
    };
  }

  return {
    subject: "Confirm the deletion of your account - Padmakara",
    ...renderBrandEmail({
      lang: "en",
      subject: "Confirm the deletion of your account - Padmakara",
      kicker: "Account",
      paragraphs: [
        "We received a request to delete your Padmakara account. If it was you, click the button below to confirm. Your account and personal data (progress, bookmarks, devices) will be permanently deleted. Payment records are kept only for accounting purposes, as the law requires.",
        "If you did not make this request, ignore this email: nothing will be deleted.",
      ],
      note: "This link expires in one hour.",
      button: { label: "Continue to deletion", href: confirmUrl },
    }),
  };
}
