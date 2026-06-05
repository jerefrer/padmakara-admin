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
