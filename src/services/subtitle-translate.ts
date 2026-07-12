export interface Cue { start: number; end: number; text: string }
export interface Sentence { start: number; end: number; text: string; cueCount: number }

const TS = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
const SENTENCE_END = /[.!?…]["')\]]?$/;
const MAX_LINE = 42;

function parseTs(s: string): number {
  const m = s.match(TS);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined) return 0;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

function fmtTs(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(r, 3)}`;
}

export function parseVtt(vtt: string): Cue[] {
  const blocks = vtt.replace(/\r/g, "").split("\n\n");
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const parts = tl.split("-->");
    const a = parts[0] ?? "";
    const b = parts[1] ?? "";
    const text = lines.slice(lines.indexOf(tl) + 1).join(" ").trim();
    if (text) cues.push({ start: parseTs(a), end: parseTs(b), text });
  }
  return cues;
}

export function serializeVtt(cues: Cue[]): string {
  const parts = ["WEBVTT", ""];
  for (const c of cues) {
    parts.push(`${fmtTs(c.start)} --> ${fmtTs(c.end)}`);
    parts.push(wrapTwoLines(c.text));
    parts.push("");
  }
  return parts.join("\n") + "\n";
}

export function groupIntoSentences(cues: Cue[]): Sentence[] {
  const out: Sentence[] = [];
  let buf: Cue[] = [];
  const flush = () => {
    if (!buf.length) return;
    const first = buf[0];
    const last = buf[buf.length - 1];
    if (!first || !last) return;
    out.push({
      start: first.start,
      end: last.end,
      text: buf.map((c) => c.text).join(" ").trim(),
      cueCount: buf.length,
    });
    buf = [];
  };
  for (const c of cues) {
    buf.push(c);
    if (SENTENCE_END.test(c.text.trim())) flush();
  }
  flush();
  return out;
}

function wrapTwoLines(text: string, maxLine = MAX_LINE): string {
  const words = text.split(/\s+/);
  let line = "";
  const lines: string[] = [];
  for (const w of words) {
    const cand = `${line} ${w}`.trim();
    if (cand.length > maxLine && line) { lines.push(line); line = w; } else line = cand;
  }
  if (line) lines.push(line);
  return lines.length <= 2 ? lines.join("\n") : lines.join(" ");
}

/** Split a translated sentence across [start,end] into ~cueCount cues, proportional to char length. */
export function recueSentence(s: Sentence, translation: string): Cue[] {
  const pieces = splitSentenceText(translation, s.cueCount);
  const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
  const span = s.end - s.start;
  const cues: Cue[] = [];
  let t = s.start;
  pieces.forEach((piece, i) => {
    const dur = (piece.length / total) * span;
    const end = i === pieces.length - 1 ? s.end : t + dur;
    cues.push({ start: t, end, text: piece });
    t = end;
  });
  return cues;
}

/** Greedy split into n chunks at word boundaries, balancing length. */
function splitSentenceText(text: string, n: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (n <= 1 || words.length <= 1) return [text.trim()];
  const target = Math.ceil(words.length / n);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += target) chunks.push(words.slice(i, i + target).join(" "));
  return chunks;
}

// ---------------------------------------------------------------------------
// Translation via Anthropic Claude (structured output)
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "../config.js";
import { glossaryBlock } from "./glossary.js";

const LANG_NAMES: Record<string, string> = { pt: "Portuguese", es: "Spanish", fr: "French" };
const CHUNK = 80;

const TranslationSchema = z.object({
  translations: z.array(
    z.object({
      id: z.number().int(),
      text: z.string(),
    }),
  ),
});

/**
 * Translate an array of English sentences into `targetLang` using Claude.
 * Preserves order; falls back to the source sentence on a missing id.
 * Processes in chunks of up to `CHUNK` sentences per API call.
 */
export async function translateSentences(
  sentences: string[],
  targetLang: string,
  model: string,
): Promise<string[]> {
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const langName = LANG_NAMES[targetLang] ?? targetLang;
  const result: string[] = [];

  for (let i = 0; i < sentences.length; i += CHUNK) {
    const batch = sentences.slice(i, i + CHUNK);
    const numbered = batch.map((s, j) => ({ id: j, text: s }));

    const res = await client.messages.parse({
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text:
            `You are a subtitle translator for Buddhist retreat teachings. Translate each numbered ` +
            `English sentence into ${langName}, preserving the reverent register. Keep meaning faithful ` +
            `and natural; prefer concise phrasing suitable for on-screen subtitles. Return one translation ` +
            `per input id, same ids.\n\n${glossaryBlock()}`,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: JSON.stringify({ sentences: numbered }) }],
      output_config: {
        format: zodOutputFormat(TranslationSchema),
      },
    });

    const parsed = res.parsed_output;
    if (!parsed) throw new Error("Translation returned no structured output");

    const byId = new Map(parsed.translations.map((t) => [t.id, t.text]));
    for (let j = 0; j < batch.length; j++) result.push(byId.get(j) ?? batch[j]!);
  }

  return result;
}

// ---------------------------------------------------------------------------
// translateSubtitles — orchestration
// ---------------------------------------------------------------------------

import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions } from "../db/schema/sessions.js";
import { sessionVideos } from "../db/schema/session-videos.js";
import { events } from "../db/schema/retreats.js";
import { sessionSubtitles } from "../db/schema/session-subtitles.js";
import { subtitleJobs } from "../db/schema/subtitle-jobs.js";
import { getObjectText, putObject } from "./s3.js";
import { addCaption } from "./bunny-captions.js";
import { isAllowedModel } from "./translation-models.js";

const LABELS: Record<string, string> = { pt: "Português", es: "Español", fr: "Français" };

export async function translateSubtitles(
  sessionId: number,
  targetLang: string,
  model: string,
): Promise<{ s3Key: string; jobId: string }> {
  if (!isAllowedModel(model)) throw new Error(`Model not allowed: ${model}`);

  const [job] = await db
    .insert(subtitleJobs)
    .values({ sessionId, language: targetLang, model, status: "processing", submittedAt: new Date() })
    .returning();

  if (!job) throw new Error("Failed to create subtitle job");

  try {
    const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
    if (!session) throw new Error("Session not found");

    const source = await db.query.sessionSubtitles.findFirst({
      where: and(eq(sessionSubtitles.sessionId, sessionId), eq(sessionSubtitles.language, "en")),
    });
    if (!source) throw new Error("No English source subtitles to translate");

    const cues = parseVtt(await getObjectText(source.s3Key));
    const sentences = groupIntoSentences(cues);
    const translations = await translateSentences(
      sentences.map((s) => s.text),
      targetLang,
      model,
    );

    const outCues: Cue[] = [];
    sentences.forEach((s, i) => outCues.push(...recueSentence(s, translations[i] ?? s.text)));
    const vtt = serializeVtt(outCues);

    const event = await db.query.events.findFirst({ where: eq(events.id, session.eventId) });
    if (!event) throw new Error("Event not found");

    const s3Key = `events/${event.eventCode}/subtitles/${session.sessionNumber}/${targetLang}.vtt`;
    await putObject(s3Key, Buffer.from(vtt), "text/vtt");

    await db
      .insert(sessionSubtitles)
      .values({
        sessionId,
        language: targetLang,
        label: LABELS[targetLang] ?? targetLang,
        s3Key,
        origin: "translation",
        source: "auto",
      })
      .onConflictDoUpdate({
        target: [sessionSubtitles.sessionId, sessionSubtitles.language],
        set: { s3Key, source: "auto", stale: false, updatedAt: new Date() },
      });

    // TODO(multi-video-subtitles): translations are only ever uploaded to
    // the primary (position 0) session_video's captions.
    const video = await db.query.sessionVideos.findFirst({
      where: eq(sessionVideos.sessionId, sessionId),
      orderBy: (v, { asc }) => [asc(v.position)],
    });

    if (video?.bunnyVideoId) {
      await addCaption(video.bunnyVideoId, targetLang, LABELS[targetLang] ?? targetLang, vtt);
      await db
        .update(sessionSubtitles)
        .set({ bunnyUploadedAt: new Date() })
        .where(
          and(eq(sessionSubtitles.sessionId, sessionId), eq(sessionSubtitles.language, targetLang)),
        );
    }

    await db
      .update(subtitleJobs)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(subtitleJobs.id, job.id));

    return { s3Key, jobId: job.id };
  } catch (err) {
    await db
      .update(subtitleJobs)
      .set({ status: "failed", errorMessage: String(err), completedAt: new Date(), updatedAt: new Date() })
      .where(eq(subtitleJobs.id, job.id));
    throw err;
  }
}
