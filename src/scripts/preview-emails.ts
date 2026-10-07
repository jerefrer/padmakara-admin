import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMagicLinkEmail } from "../services/email.ts";
import {
  buildWelcomeEmail,
  buildPaymentFailedEmail,
  buildCancelledEmail,
  buildFirstPaymentFailedEmail,
} from "../services/membership-emails.ts";
import type { Lang } from "../services/email-template.ts";

/**
 * Renders every email we send, in both languages, to files you can open.
 *
 *   bun run email:preview
 *
 * There is no way to see these short of sending one, and sending one costs a
 * real message to a real address. This renders exactly what SES would carry —
 * a browser is not a mail client, so it flatters the result, but it catches
 * the things worth catching before a send: wrong language, a broken mark,
 * copy that does not fit.
 *
 * The mark loads from `config.urls.backend`, so run `bun run dev` alongside
 * this to see it; without the API up the preview shows the message as a reader
 * with images blocked sees it, which is also worth looking at.
 */

const APP = "http://localhost:8081";
const NEXT_PAYMENT = new Date("2026-11-15T12:00:00Z");

const SAMPLES = (lang: Lang) => ({
  "magic-link": buildMagicLinkEmail(
    `http://localhost:3000/api/auth/activate/preview-token?lang=${lang}`,
    lang,
  ),
  welcome: buildWelcomeEmail({
    lang,
    firstName: "Ana",
    amount: 12,
    interval: "month",
    nextPaymentAt: NEXT_PAYMENT,
    manageUrl: `${APP}/membership`,
    retreatsUrl: `${APP}/`,
  }),
  "payment-failed": buildPaymentFailedEmail({
    lang,
    firstName: "Ana",
    graceUntil: NEXT_PAYMENT,
    updateUrl: `${APP}/membership`,
  }),
  cancelled: buildCancelledEmail({
    lang,
    firstName: "Ana",
    accessUntil: NEXT_PAYMENT,
    resumeUrl: `${APP}/membership`,
  }),
  "first-payment-failed": buildFirstPaymentFailedEmail({
    lang,
    firstName: "Ana",
    joinUrl: `${APP}/membership`,
  }),
});

const dir = await mkdtemp(join(tmpdir(), "padmakara-emails-"));
const written: { name: string; subject: string; path: string }[] = [];

for (const lang of ["en", "pt"] as const) {
  for (const [name, email] of Object.entries(SAMPLES(lang))) {
    const base = `${name}.${lang}`;
    await writeFile(join(dir, `${base}.html`), email.html, "utf8");
    await writeFile(join(dir, `${base}.txt`), email.text, "utf8");
    written.push({ name: base, subject: email.subject, path: join(dir, `${base}.html`) });
  }
}

/** A contact sheet, so all ten can be judged side by side rather than one tab at a time. */
const index = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Padmakara emails</title>
<style>
  body { margin:0; background:#e7e5e2; font:14px Georgia, serif; color:#2c2c2c; }
  h1 { font-size:16px; letter-spacing:3px; text-transform:uppercase; color:#9b1b1b; padding:24px 24px 0; margin:0; }
  .sheet { display:grid; grid-template-columns:repeat(auto-fill, minmax(360px, 1fr)); gap:24px; padding:24px; }
  figure { margin:0; }
  figcaption { padding:8px 2px; font-size:13px; }
  figcaption b { display:block; font-weight:normal; color:#5f6570; }
  iframe { width:100%; height:620px; border:1px solid #b8b6b3; background:#f5f4f2; }
</style>
</head>
<body>
<h1>Padmakara emails</h1>
<div class="sheet">
${written
  .map(
    (w) => `<figure>
<iframe src="./${w.name}.html" title="${w.name}"></iframe>
<figcaption>${w.name}<b>${w.subject}</b></figcaption>
</figure>`,
  )
  .join("\n")}
</div>
</body>
</html>`;

await writeFile(join(dir, "index.html"), index, "utf8");

console.log(`${written.length} emails rendered (HTML + plain text).\n`);
for (const w of written) console.log(`  ${w.name.padEnd(28)} ${w.subject}`);
console.log(`\nOpen them all at once:\n\n  open ${join(dir, "index.html")}\n`);
