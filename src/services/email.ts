import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { config } from "../config.ts";

const ses = new SESClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

/**
 * Send an email via AWS SES in production, or log to console in development.
 */
export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  if (config.isDev) {
    console.log(`[EMAIL] To: ${options.to}`);
    console.log(`[EMAIL] Subject: ${options.subject}`);
    console.log(`[EMAIL] Body: ${options.html}`);
    return;
  }

  const command = new SendEmailCommand({
    Source: config.email.fromEmail,
    Destination: { ToAddresses: [options.to] },
    Message: {
      Subject: { Data: options.subject, Charset: "UTF-8" },
      Body: { Html: { Data: options.html, Charset: "UTF-8" } },
    },
  });

  await ses.send(command);
  console.log(`[EMAIL] Sent to ${options.to}: ${options.subject}`);
}

export function buildMagicLinkEmail(
  magicLinkUrl: string,
  language: string,
): { subject: string; html: string } {
  if (language === "pt") {
    return {
      subject: "O seu link de acesso - Padmakara",
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Padmakara</h2>
          <p>Clique no link abaixo para aceder à sua conta:</p>
          <p><a href="${magicLinkUrl}" style="display: inline-block; padding: 12px 24px; background: #9b1b1b; color: white; text-decoration: none; border-radius: 6px;">Aceder à minha conta</a></p>
          <p style="color: #666; font-size: 14px;">Este link expira em 1 hora.</p>
        </div>
      `,
    };
  }

  return {
    subject: "Your login link - Padmakara",
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Padmakara</h2>
        <p>Click the link below to access your account:</p>
        <p><a href="${magicLinkUrl}" style="display: inline-block; padding: 12px 24px; background: #9b1b1b; color: white; text-decoration: none; border-radius: 6px;">Access my account</a></p>
        <p style="color: #666; font-size: 14px;">This link expires in 1 hour.</p>
      </div>
    `,
  };
}
