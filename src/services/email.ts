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
): { subject: string; html: string; text: string } {
  if (lang(language) === "pt") {
    return {
      subject: "O seu link de acesso - Padmakara",
      ...renderBrandEmail({
        lang: "pt",
        subject: "O seu link de acesso - Padmakara",
        kicker: "Acesso",
        paragraphs: ["Carregue no botão abaixo para aceder à sua conta."],
        note: "Este link expira dentro de uma hora.",
        button: { label: "Aceder à minha conta", href: magicLinkUrl },
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
      note: "This link expires in one hour.",
      button: { label: "Access my account", href: magicLinkUrl },
    }),
  };
}
