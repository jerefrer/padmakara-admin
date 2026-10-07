import { config } from "../config.ts";

/**
 * The frame every Padmakara email wears.
 *
 * It is the shell the Tibetan course site already sends (see
 * tibetan-course-with-wulstan/src/lib/emailTemplate.ts): same mark, same
 * letter-spaced PADMAKARA, same cream ground, same hairline rules. One brand,
 * one envelope — a member who gets a login link and then a welcome message
 * should not be able to tell they came from two different systems.
 *
 * Deliberately a copy and not an import: the two codebases deploy separately,
 * and a shared package between them would have to be versioned and released to
 * change a colour. The values below are the contract; the snapshot in
 * tests/services/email-template.test.ts is what stops them drifting quietly.
 */

export type Lang = "en" | "pt";

/**
 * Padmakara's own colours, repeated here rather than imported from a theme.
 * Email has no stylesheet to share: every value has to travel inline on the
 * element that uses it, so a constant is the closest thing to a token.
 */
const CREAM = "#f5f4f2";
const INK = "#2c2c2c";
const INK_MUTED = "#5f6570";
const BURGUNDY = "#9b1b1b";
const RULE = "#b8b6b3";

/**
 * Georgia, not EB Garamond. Outlook and Gmail ignore webfonts, so naming the
 * app's typeface would only mean falling through to a default sans on most
 * clients. Georgia ships everywhere, is a serif, and is the closest thing to
 * the app that a mail client can be relied on to have.
 */
const SERIF = "Georgia, 'Times New Roman', Times, serif";

/** Names and amounts are a person's own text. They must not close a tag. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The mark, served by this API rather than by the app: api.padmakara.pt is up
 * whenever an email can be sent at all, whereas the app's web build may not
 * have been deployed. See src/routes/email-assets.ts.
 */
export function markUrl(): string {
  return `${config.urls.backend.replace(/\/+$/, "")}/api/email-assets/mark.png`;
}

/**
 * Saying why a message arrived is what separates a real notification from
 * something that looks like spam, and it is the one line a reader checks when
 * they do not recognise the sender.
 */
const FOOTER: Record<Lang, string> = {
  en: "You are receiving this message because of activity on your Padmakara account.",
  pt: "Está a receber esta mensagem devido a atividade na sua conta Padmakara.",
};

export interface BrandEmail {
  lang: Lang;
  /** Also the document title. The caller keeps it as the SES subject. */
  subject: string;
  /**
   * What kind of message this is, in a word or two — letter-spaced capitals
   * above the letter. A kicker and not a heading: a heading over a letter only
   * repeats the letter's own first sentence.
   */
  kicker: string;
  /** "Dear Ana," — already plain text, escaped here. */
  greeting?: string;
  /** One <p> each. Blank entries are dropped. */
  paragraphs: string[];
  /** A muted line under the letter, before the button. */
  note?: string;
  /** The one thing to do. Burgundy, square, centred text on a solid ground. */
  button?: { label: string; href: string };
  /** The lesser thing to do, as a link rather than a second slab of burgundy. */
  secondary?: { label: string; href: string };
}

/**
 * HTML and plain text are two renderings of one description, so they cannot
 * drift. The text part is not decoration: HTML-only mail scores worse with
 * spam filters, and some readers genuinely see only this.
 */
export function renderBrandEmail(e: BrandEmail): { html: string; text: string } {
  return { html: renderHtml(e), text: renderText(e) };
}

function renderText(e: BrandEmail): string {
  const parts: string[] = [e.kicker.toUpperCase()];

  if (e.greeting) parts.push(e.greeting);
  for (const p of e.paragraphs) if (p.trim()) parts.push(p);
  if (e.note) parts.push(e.note);
  if (e.button) parts.push(`${e.button.label}: ${e.button.href}`);
  if (e.secondary) parts.push(`${e.secondary.label}: ${e.secondary.href}`);

  return `${parts.join("\n\n")}\n\n—\n${FOOTER[e.lang]}`;
}

/**
 * Tables and inline styles throughout, because Outlook renders mail with
 * Word's engine — no flexbox, no grid, no external stylesheet. Width is capped
 * at 600px, the width every client is known to give without horizontal
 * scrolling.
 */
function renderHtml(e: BrandEmail): string {
  const paragraph = (text: string) =>
    `<p style="margin:0 0 18px;font-family:${SERIF};font-size:17px;line-height:1.65;color:${INK};">${escapeHtml(text).replaceAll("\n", "<br />")}</p>`;

  const kicker = `<p style="margin:0 0 22px;font-family:${SERIF};font-size:12px;line-height:1.4;letter-spacing:3px;text-transform:uppercase;color:${BURGUNDY};">${escapeHtml(e.kicker)}</p>`;

  const greeting = e.greeting ? paragraph(e.greeting) : "";
  const body = e.paragraphs.filter((p) => p.trim()).map(paragraph).join("");

  const note = e.note
    ? `<p style="margin:0 0 18px;font-family:${SERIF};font-size:15px;line-height:1.6;color:${INK_MUTED};">${escapeHtml(e.note)}</p>`
    : "";

  /*
   * A table with a background colour and not a padded <a>: Outlook drops the
   * padding on an inline-block, leaving a bare word of white text on cream.
   * Square corners — border-radius is ignored by the same engine, so a rounded
   * button is only rounded for half the readers.
   */
  const button = e.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0;">
<tr>
<td align="center" bgcolor="${BURGUNDY}" style="background-color:${BURGUNDY};">
<a href="${escapeHtml(e.button.href)}" style="display:inline-block;padding:12px 24px;font-family:${SERIF};font-size:16px;color:#ffffff;text-decoration:none;">${escapeHtml(e.button.label)}</a>
</td>
</tr>
</table>`
    : "";

  /*
   * The second action is a link, not a second button. Two burgundy slabs read
   * as two equal choices, and these emails always have one thing worth doing
   * and one thing worth knowing is possible.
   */
  const secondary = e.secondary
    ? `<p style="margin:18px 0 0;font-family:${SERIF};font-size:15px;line-height:1.6;"><a href="${escapeHtml(e.secondary.href)}" style="color:${BURGUNDY};text-decoration:underline;">${escapeHtml(e.secondary.label)}</a></p>`
    : "";

  /*
   * The footer row draws its rule on its own top edge, so whatever the body
   * ends with sits directly on it. Harmless after a paragraph, which carries
   * an 18px margin; flush against a button, which does not. A spacer row and
   * not a margin on the button's table, because Outlook drops margins on
   * tables.
   */
  const spacer = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="height:36px;font-size:0;line-height:0;">&nbsp;</td></tr>
</table>`;

  /*
   * The mark is a PNG and not an SVG: no major mail client renders SVG. It is
   * also not load-bearing — clients block remote images by default, and
   * PADMAKARA below it is live text, so the message still arrives looking like
   * itself with images turned off.
   */
  return `<!doctype html>
<html lang="${e.lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(e.subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${CREAM};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${CREAM};">
<tr>
<td align="center" style="padding:32px 16px 48px;">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

<tr>
<td align="center" style="padding:0 0 12px;">
<img src="${markUrl()}" width="60" height="60" alt=""
     style="display:block;border:0;width:60px;height:60px;" />
</td>
</tr>

<tr>
<td align="center" style="padding:0 0 28px;font-family:${SERIF};font-size:13px;letter-spacing:4px;color:${BURGUNDY};">
PADMAKARA
</td>
</tr>

<tr>
<td style="padding:0 0 28px;border-top:1px solid ${RULE};font-size:0;line-height:0;">&nbsp;</td>
</tr>

<tr>
<td style="padding:0 8px;">
${kicker}${greeting}${body}${note}${button}${secondary}${spacer}
</td>
</tr>

<tr>
<td style="padding:28px 8px 0;border-top:1px solid ${RULE};">
<p style="margin:0;font-family:${SERIF};font-size:14px;line-height:1.6;color:${INK_MUTED};">
${escapeHtml(FOOTER[e.lang])}
</p>
</td>
</tr>

</table>
</td>
</tr>
</table>
</body>
</html>`;
}
