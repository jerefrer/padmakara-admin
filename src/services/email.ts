import { config } from "../config.ts";

/**
 * Send an email. In development, just logs to console.
 * In production, integrate with AWS SES.
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

  // TODO: Integrate AWS SES when ready for production
  // For now, log in all environments
  console.log(`[EMAIL] Would send to ${options.to}: ${options.subject}`);
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
          <p><a href="${magicLinkUrl}" style="display: inline-block; padding: 12px 24px; background: #4A5568; color: white; text-decoration: none; border-radius: 6px;">Aceder à minha conta</a></p>
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
        <p><a href="${magicLinkUrl}" style="display: inline-block; padding: 12px 24px; background: #4A5568; color: white; text-decoration: none; border-radius: 6px;">Access my account</a></p>
        <p style="color: #666; font-size: 14px;">This link expires in 1 hour.</p>
      </div>
    `,
  };
}
