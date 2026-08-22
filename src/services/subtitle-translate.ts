export interface Cue { start: number; end: number; text: string; spokenStart?: number }
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
  applyTiming(cues);
  const parts = ["WEBVTT", ""];
  for (const c of cues) {
    parts.push(`${fmtTs(c.start)} --> ${fmtTs(c.end)}`);
    parts.push(wrapLines(c.text));
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

export const MAX_CUE_SECONDS = 7;
export const MIN_CUE_SECONDS = 0.833;
export const MIN_GAP_SECONDS = 0.08;
export const MAX_CHARS_PER_SECOND = 17;
export const LEAD_IN_SECONDS = 0.5;
export const CLUSTER_RELIEF_FACTOR = 2;
export const DISTRESS_LEAD_IN_SECONDS = 3;

/**
 * Words a Portuguese subtitle line may not end on. Breaking here separates an
 * article from its noun, a preposition from its complement, a clitic from its
 * verb. The translation is ours to shape, but the break point is the cheapest
 * thing to get right, so the rule costs nothing.
 */
export const PT_WEAK_LINE_ENDINGS = new Set([
  "o", "a", "os", "as", "um", "uma", "uns", "umas",
  "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas",
  "por", "pelo", "pela", "pelos", "pelas", "para", "com", "sem", "sob", "sobre",
  "ao", "à", "aos", "às", "e", "ou", "mas", "nem", "que", "se", "porque",
  "quando", "onde", "como", "qual", "quais", "cujo", "cuja",
  "meu", "minha", "seu", "sua", "nosso", "nossa", "este", "esta", "esse",
  "essa", "aquele", "aquela", "é", "são", "foi", "era", "ser", "estar",
  "está", "tem", "têm", "há", "não", "muito", "mais", "já",
]);

function endsWeakly(line: string): boolean {
  const last = line.replace(/[ ,.;:!?…]+$/, "").split(/\s+/).pop();
  return !!last && PT_WEAK_LINE_ENDINGS.has(last.toLowerCase().replace(/[«»"'’‘]/g, ""));
}

/**
 * Lay text out on at most two balanced lines, breaking at the best boundary:
 * sentence-final punctuation first, then semicolon or colon, then comma or
 * dash, then any other phrase boundary — and never leaving a function word
 * stranded at the end of a line or a stub on either side.
 */
export function wrapLines(text: string, maxLine = MAX_LINE): string {
  const clean = text.split(/\s+/).filter(Boolean).join(" ");
  if (clean.length <= maxLine) return clean;

  const words = clean.split(" ");
  let best: number | null = null;
  let bestScore: [number, number] | null = null;

  for (let cut = 1; cut < words.length; cut++) {
    const left = words.slice(0, cut).join(" ");
    const right = words.slice(cut).join(" ");
    if (left.length > maxLine || right.length > maxLine) continue;

    const tail = words[cut - 1]!;
    const punctuation = /[.!?…]$/.test(tail) ? 4
      : /[;:]$/.test(tail) ? 3
      : /[,—–]$/.test(tail) ? 2
      : 0;
    const stub = Math.min(left.length, right.length) >= 12 ? 0 : -2;
    // Punctuation settles it: a comma is a real boundary even after "para".
    const weak = punctuation === 0 && endsWeakly(left) ? -3 : 0;
    const score: [number, number] = [
      punctuation + stub + weak,
      -Math.abs(left.length - right.length) / maxLine,
    ];
    if (!bestScore || score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      best = cut;
      bestScore = score;
    }
  }
  if (best === null) return clean;
  return `${words.slice(0, best).join(" ")}\n${words.slice(best).join(" ")}`;
}

/**
 * Give every subtitle a legal duration without disturbing its neighbours: hold
 * it long enough to be read, lengthen into any following silence to relieve the
 * reading speed, then cap it and leave a gap. Start times are never moved.
 */
export function applyTiming(cues: Cue[]): Cue[] {
  // Anchored on the cue: this runs again after other passes, and re-reading the
  // shifted start would take another half second off every time.
  const spoken = cues.map((c) => (c.spokenStart ??= c.start));
  fit(cues, spoken, false);
  sharePressure(cues);
  fit(cues, spoken, true);
  return cues;
}

/**
 * Forward pass: finish each subtitle before moving to the next. A subtitle may
 * appear slightly before its first word, which is conventional and uses silence
 * that is otherwise wasted. Each start is bounded below by the previous
 * subtitle's finished end, so overlaps cannot happen.
 *
 * `spoken` holds where the words actually begin, so running this more than once
 * does not walk the subtitle further and further ahead of the speech.
 */
function fit(cues: Cue[], spoken: number[], relieveReadingSpeed: boolean): void {
  let previousEnd: number | null = null;
  cues.forEach((cue, i) => {
    const floor = previousEnd === null ? 0 : previousEnd + MIN_GAP_SECONDS;
    const next = cues[i + 1];
    const ceiling = next ? next.start - MIN_GAP_SECONDS : null;

    const chars = cue.text.replace(/\n/g, " ").length;
    let wanted = MIN_CUE_SECONDS;
    if (relieveReadingSpeed) wanted = Math.max(wanted, chars / MAX_CHARS_PER_SECOND);
    wanted = Math.min(wanted, MAX_CUE_SECONDS);

    const settle = (start: number): number => {
      let end = Math.max(cue.end, start + wanted);
      if (ceiling !== null) end = Math.min(end, Math.max(ceiling, start));
      end = Math.ceil(end * 1000) / 1000;
      return Math.min(end, start + MAX_CUE_SECONDS);
    };

    // Holding a subtitle longer is free; showing it before it is spoken is not.
    // Take what the silence ahead gives first, and only reach backwards for
    // whatever is still missing — otherwise every subtitle drifts early to help
    // the few that need it.
    let end = settle(cue.start);
    const shortfall = wanted - (end - cue.start);
    if (shortfall > 1e-9) {
      const earliest = Math.max((spoken[i] ?? cue.start) - LEAD_IN_SECONDS, floor);
      cue.start = Math.round(Math.max(earliest, cue.start - shortfall) * 1000) / 1000;
      end = settle(cue.start);
    }

    cue.end = end;
    previousEnd = cue.end;
  });
}

/**
 * Even out a run of subtitles packed far past the reading speed, and let it
 * reach back into any silence in front. Sharing time inside such a run only
 * levels the rates; the run as a whole needs more room, and unused silence
 * ahead of it is the only place to find any.
 */
function sharePressure(cues: Cue[]): void {
  const rate = (c: Cue) => {
    const span = c.end - c.start;
    return span > 0 ? c.text.replace(/\n/g, " ").length / span : Infinity;
  };

  let i = 0;
  while (i < cues.length) {
    if (rate(cues[i]!) <= MAX_CHARS_PER_SECOND * CLUSTER_RELIEF_FACTOR) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < cues.length && rate(cues[j + 1]!) > MAX_CHARS_PER_SECOND) j++;
    const run = cues.slice(i, j + 1);
    if (run.length > 1) {
      const floor = i ? cues[i - 1]!.end + MIN_GAP_SECONDS : 0;
      const earliest = Math.max(floor, run[0]!.start - DISTRESS_LEAD_IN_SECONDS);
      run[0]!.start = Math.round(Math.min(run[0]!.start, earliest) * 1000) / 1000;

      const window =
        run[run.length - 1]!.end - run[0]!.start - MIN_GAP_SECONDS * (run.length - 1);
      const weights = run.map((c) => c.text.replace(/\n/g, " ").length);
      const total = weights.reduce((a, b) => a + b, 0) || 1;
      let cursor = run[0]!.start;
      run.forEach((cue, k) => {
        cue.start = Math.round(cursor * 1000) / 1000;
        cursor += (window * weights[k]!) / total;
        cue.end = Math.round(cursor * 1000) / 1000;
        cursor += MIN_GAP_SECONDS;
      });
    }
    i = j + 1;
  }
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

/**
 * European-Portuguese norms for the translator.
 *
 * Without these the model drifts into Brazilian forms — measured on the 14 April
 * subtitles: "o fato de" four times (in Portugal a *fato* is a suit), four
 * Brazilian progressive gerunds, "celular" and "banheiro". Roughly ten slips per
 * video. The block sits in a cached system prompt, so it costs nothing per call.
 */
const PT_PT_STYLE = [
  "EUROPEAN PORTUGUESE (Portugal), norma culta. Never Brazilian forms.",
  "- Clitics: enclisis by default (chama-se, lembro-me, fá-lo). Proclisis when an",
  "  attracting word precedes the verb in the same clause — negation (não, nunca,",
  "  nem), subordinators (que, porque, quando, se, como, onde, quem), adverbs (já,",
  "  ainda, sempre, só, também, talvez), quantifiers (tudo, todos, alguém), and in",
  "  questions opened by an interrogative. So 'o que se chama' is correct — do not",
  "  'fix' it to 'chama-se'. Mesoclisis in future/conditional with no attractor:",
  "  dir-lhe-ei, dar-te-ia.",
  "- Enclisis euphony: ver + o → vê-lo; faz + o → fá-lo; dão + o → dão-no;",
  "  encontramos + nos → encontramo-nos.",
  "- Article before the possessive, contracted with any preposition: a minha casa,",
  "  da minha, na sua, à sua.",
  "- Progressive is 'estar a + infinitive', never the gerund: 'está a fazer', not",
  "  'está fazendo'; 'continuar a derramar', not 'continuar derramando'. Keep the",
  "  gerund only in adverbial use ('sabendo isso, ...').",
  "- Contractions: num, numa, noutro, nalgum, nisto, nisso, naquilo, disto, doutro.",
  "- Address: never 'você'. Use tu or impersonal forms; plural 'vocês' with plural",
  "  agreement.",
  "- Spelling (1990 Agreement, Portugal): facto (de facto), contacto, receção,",
  "  conceção, fenómeno, género, económico, tónico, académico. Never fato, contato,",
  "  fenômeno, gênero.",
  "- Lexicon: comboio, autocarro, ecrã, frigorífico, equipa, pequeno-almoço,",
  "  casa de banho, telemóvel, rapaz/miúdo. Never trem, ônibus, tela, geladeira,",
  "  time, café da manhã, banheiro, celular, garoto.",
].join("\n");

/**
 * A speaker ID opens a turn in a question-and-answer exchange. It must survive
 * translation in the same shape, or the subtitle stops saying who is talking.
 */
const SPEAKER_ID_RULE = [
  "A sentence may open with a speaker ID in square brackets and uppercase, e.g.",
  "'[STUDENT 1] Can you do it walking?'. Keep that shape: translate the role",
  "([STUDENT 1] → [ESTUDANTE 1], [RINPOCHE] → [RINPOCHE]), keep it uppercase and",
  "bracketed, keep it first, and never merge it into the sentence.",
].join("\n");

function styleBlock(targetLang: string): string {
  const parts = [SPEAKER_ID_RULE];
  if (targetLang === "pt") parts.unshift(PT_PT_STYLE);
  return parts.join("\n\n");
}

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
            `per input id, same ids.\n\n${styleBlock(targetLang)}\n\n${glossaryBlock()}`,
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
import { eventVideos } from "../db/schema/event-videos.js";
import { events } from "../db/schema/retreats.js";
import { videoSubtitles } from "../db/schema/video-subtitles.js";
import { subtitleJobs } from "../db/schema/subtitle-jobs.js";
import { getObjectText, putObject } from "./s3.js";
import { addCaption } from "./bunny-captions.js";
import { isAllowedModel } from "./translation-models.js";

const LABELS: Record<string, string> = { pt: "Português", es: "Español", fr: "Français" };

export async function translateSubtitles(
  videoId: number,
  targetLang: string,
  model: string,
): Promise<{ s3Key: string; jobId: string }> {
  if (!isAllowedModel(model)) throw new Error(`Model not allowed: ${model}`);

  const video = await db.query.eventVideos.findFirst({
    where: eq(eventVideos.id, videoId),
  });
  if (!video) throw new Error("Event video not found");

  const [job] = await db
    .insert(subtitleJobs)
    .values({
      videoId,
      language: targetLang,
      model,
      status: "processing",
      submittedAt: new Date(),
    })
    .returning();

  if (!job) throw new Error("Failed to create subtitle job");

  try {
    const source = await db.query.videoSubtitles.findFirst({
      where: and(
        eq(videoSubtitles.videoId, videoId),
        eq(videoSubtitles.language, "en"),
      ),
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

    const event = await db.query.events.findFirst({ where: eq(events.id, video.eventId) });
    if (!event) throw new Error("Event not found");

    const s3Key = `events/${event.eventCode}/subtitles/v${videoId}/${targetLang}.vtt`;
    await putObject(s3Key, Buffer.from(vtt), "text/vtt");

    await db
      .insert(videoSubtitles)
      .values({
        videoId,
        language: targetLang,
        label: LABELS[targetLang] ?? targetLang,
        s3Key,
        origin: "translation",
        source: "auto",
      })
      .onConflictDoUpdate({
        target: [videoSubtitles.videoId, videoSubtitles.language],
        set: { s3Key, source: "auto", stale: false, updatedAt: new Date() },
      });

    if (video.bunnyVideoId) {
      await addCaption(video.bunnyVideoId, targetLang, LABELS[targetLang] ?? targetLang, vtt);
      await db
        .update(videoSubtitles)
        .set({ bunnyUploadedAt: new Date() })
        .where(
          and(
            eq(videoSubtitles.videoId, videoId),
            eq(videoSubtitles.language, targetLang),
          ),
        );
    }

    // Defensive: if this translation call ever produces an "en" track (not
    // expected in normal flow, which always translates FROM en), mark this
    // video's other translations stale since the source just changed.
    if (targetLang === "en") {
      await db
        .update(videoSubtitles)
        .set({ stale: true, updatedAt: new Date() })
        .where(
          and(
            eq(videoSubtitles.videoId, videoId),
            eq(videoSubtitles.origin, "translation"),
          ),
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
