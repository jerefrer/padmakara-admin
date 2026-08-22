import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseVtt, serializeVtt, groupIntoSentences, recueSentence , wrapLines, applyTiming, PT_WEAK_LINE_ENDINGS } from "../../src/services/subtitle-translate";

const SAMPLE = `WEBVTT

00:00:00.000 --> 00:00:00.900
Hello there.

00:00:01.000 --> 00:00:02.000
This is a test

00:00:02.000 --> 00:00:03.000
of subtitles.
`;

describe("parseVtt", () => {
  it("parses cues with seconds", () => {
    const cues = parseVtt(SAMPLE);
    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ start: 0, end: 0.9, text: "Hello there." });
    expect(cues[2]?.text).toBe("of subtitles.");
  });
});

describe("serializeVtt round-trips", () => {
  it("re-emits valid WEBVTT", () => {
    const out = serializeVtt(parseVtt(SAMPLE));
    expect(out.startsWith("WEBVTT\n\n")).toBe(true);
    expect(out).toContain("00:00:00.000 --> 00:00:00.900");
  });
});

describe("groupIntoSentences", () => {
  it("groups cues until sentence-ending punctuation", () => {
    const groups = groupIntoSentences(parseVtt(SAMPLE));
    expect(groups).toHaveLength(2);
    expect(groups[1]?.text).toBe("This is a test of subtitles.");
    expect(groups[1]?.start).toBe(1.0);
    expect(groups[1]?.end).toBe(3.0);
  });
});

describe("recueSentence", () => {
  it("splits a translation across the time span proportionally", () => {
    const cues = recueSentence(
      { start: 0, end: 4, text: "ignored", cueCount: 2 },
      "Bonjour le monde. Comment ça va aujourd'hui ?",
    );
    expect(cues.length).toBeGreaterThanOrEqual(1);
    expect(cues[0]?.start).toBe(0);
    expect(cues[cues.length - 1]?.end).toBe(4);
    for (let i = 1; i < cues.length; i++) expect(cues[i]?.start).toBeGreaterThanOrEqual(cues[i - 1]?.end ?? 0);
  });
});

// ---------------------------------------------------------------------------
// translateSentences — mocked SDK
// ---------------------------------------------------------------------------

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = {
        parse: vi.fn().mockResolvedValue({
          parsed_output: { translations: [{ id: 0, text: "Bonjour." }, { id: 1, text: "Un test." }] },
        }),
      };
    },
  };
});

it("translateSentences maps ids back to translated text", async () => {
  const { translateSentences } = await import("../../src/services/subtitle-translate");
  const out = await translateSentences(["Hello.", "A test."], "fr", "claude-opus-4-8");
  expect(out).toEqual(["Bonjour.", "Un test."]);
});

// ---------------------------------------------------------------------------
// translateSubtitles — orchestration (mocked db, S3, Bunny)
// ---------------------------------------------------------------------------

// Hoisted mocks for translateSubtitles test (db, s3, bunny-captions)
const {
  tsInsertReturning,
  tsUpdateWhere,
  tsUpdateSet,
  tsUpdate,
  tsOnConflictDoUpdate,
  tsFindFirstSourceSub,
  tsFindFirstEvent,
  tsFindFirstEventVideo,
  tsMockGetObjectText,
  tsMockPutObject,
  tsMockAddCaption,
} = vi.hoisted(() => {
  // subtitleJobs insert().values().returning() → [{id:"job-1"}]
  const tsInsertReturning = vi.fn(() => Promise.resolve([{ id: "job-1" }]));

  // videoSubtitles insert().values().onConflictDoUpdate()
  const tsOnConflictDoUpdate = vi.fn(() => Promise.resolve());

  // update().set().where()
  const tsUpdateWhere = vi.fn(() => Promise.resolve());
  const tsUpdateSet = vi.fn(() => ({ where: tsUpdateWhere }));
  const tsUpdate = vi.fn(() => ({ set: tsUpdateSet }));

  // query helpers
  const tsFindFirstSourceSub = vi.fn(() =>
    Promise.resolve({ language: "en", s3Key: "events/E/subtitles/v1/en.vtt" }),
  );
  const tsFindFirstEvent = vi.fn(() => Promise.resolve({ id: 1, eventCode: "E" }));
  const tsFindFirstEventVideo = vi.fn<
    () => Promise<{ id: number; eventId: number; position: number; bunnyVideoId: string } | null>
  >(() => Promise.resolve({ id: 1, eventId: 1, position: 0, bunnyVideoId: "vid" }));

  // s3 mocks
  const tsMockGetObjectText = vi.fn(() =>
    Promise.resolve("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello there.\n"),
  );
  const tsMockPutObject = vi.fn(() => Promise.resolve());

  // bunny-captions mock
  const tsMockAddCaption = vi.fn(() => Promise.resolve());

  return {
    tsInsertReturning,
    tsUpdateWhere,
    tsUpdateSet,
    tsUpdate,
    tsOnConflictDoUpdate,
    tsFindFirstSourceSub,
    tsFindFirstEvent,
    tsFindFirstEventVideo,
    tsMockGetObjectText,
    tsMockPutObject,
    tsMockAddCaption,
  };
});

vi.mock("../../src/db/index.ts", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: tsInsertReturning,
        onConflictDoUpdate: tsOnConflictDoUpdate,
      })),
    })),
    update: tsUpdate,
    query: {
      videoSubtitles: { findFirst: tsFindFirstSourceSub },
      events: { findFirst: tsFindFirstEvent },
      eventVideos: { findFirst: tsFindFirstEventVideo },
    },
  },
}));

vi.mock("../../src/services/s3.ts", () => ({
  getObjectText: tsMockGetObjectText,
  putObject: tsMockPutObject,
}));

vi.mock("../../src/services/bunny-captions.ts", () => ({
  addCaption: tsMockAddCaption,
}));

describe("translateSubtitles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set default return values after clearAllMocks
    tsFindFirstSourceSub.mockResolvedValue({ language: "en", s3Key: "events/E/subtitles/v1/en.vtt" });
    tsFindFirstEvent.mockResolvedValue({ id: 1, eventCode: "E" });
    tsFindFirstEventVideo.mockResolvedValue({ id: 1, eventId: 1, position: 0, bunnyVideoId: "vid" });
    tsInsertReturning.mockResolvedValue([{ id: "job-1" }]);
    tsUpdateWhere.mockResolvedValue(undefined);
    tsOnConflictDoUpdate.mockResolvedValue(undefined);
    tsMockGetObjectText.mockResolvedValue("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello there.\n");
    tsMockPutObject.mockResolvedValue(undefined);
    tsMockAddCaption.mockResolvedValue(undefined);
  });

  it("translateSubtitles produces a target VTT keyed on the event_video and uploads it", async () => {
    const { translateSubtitles } = await import("../../src/services/subtitle-translate.js");
    const out = await translateSubtitles(1, "fr", "claude-opus-4-8");
    expect(out.s3Key).toBe("events/E/subtitles/v1/fr.vtt");
    expect(tsMockAddCaption).toHaveBeenCalledWith(
      expect.any(String),
      "fr",
      expect.any(String),
      expect.stringContaining("WEBVTT"),
    );
  });

  it("throws when the event_video does not exist", async () => {
    tsFindFirstEventVideo.mockResolvedValueOnce(null);
    const { translateSubtitles } = await import("../../src/services/subtitle-translate.js");
    await expect(translateSubtitles(999, "fr", "claude-opus-4-8")).rejects.toThrow(
      "Event video not found",
    );
  });
});

// ---------------------------------------------------------------------------
// Line shaping — the same standard the English side applies, in Portuguese
// ---------------------------------------------------------------------------

describe("wrapLines", () => {
  it("keeps short text on one line", () => {
    expect(wrapLines("Muito obrigado.")).toBe("Muito obrigado.");
  });

  it("never emits more than two lines", () => {
    const text = "Isto é uma frase bastante longa que precisa de ser dividida em duas linhas para caber no ecrã";
    expect(wrapLines(text).split("\n").length).toBeLessThanOrEqual(2);
  });

  it("never exceeds 42 characters on a line", () => {
    const text = "Isto é uma frase bastante longa que precisa de ser dividida em duas linhas";
    for (const line of wrapLines(text).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(42);
    }
  });

  it("breaks straight after punctuation when there is some", () => {
    const out = wrapLines("Ele parou por instantes, e depois continuou a falar devagar");
    const [first] = out.split("\n");
    expect(first!.endsWith(",")).toBe(true);
  });

  it("does not end a line on a Portuguese function word", () => {
    const out = wrapLines("Muitas vezes temos esta ideia de que o caminho budista é muito difícil");
    const parts = out.split("\n");
    if (parts.length === 2) {
      const last = parts[0]!.replace(/[ ,.;:!?]+$/, "").split(" ").pop()!.toLowerCase();
      expect(PT_WEAK_LINE_ENDINGS.has(last)).toBe(false);
    }
  });
});

describe("applyTiming", () => {
  it("never lets two subtitles overlap", () => {
    const cues = [
      { start: 0, end: 5, text: "Primeira." },
      { start: 4, end: 8, text: "Segunda." },
    ];
    const out = applyTiming(cues);
    expect(out[0]!.end).toBeLessThanOrEqual(out[1]!.start);
  });

  it("caps a subtitle at seven seconds", () => {
    const out = applyTiming([{ start: 0, end: 97.6, text: "Uma linha." }]);
    expect(out[0]!.end - out[0]!.start).toBeLessThanOrEqual(7 + 1e-6);
  });

  it("holds a very short subtitle long enough to read", () => {
    const out = applyTiming([{ start: 1, end: 1.05, text: "Sim." }]);
    expect(out[0]!.end - out[0]!.start).toBeGreaterThanOrEqual(0.833 - 1e-6);
  });

  it("uses following silence to bring the reading speed down", () => {
    const cues = [
      { start: 0, end: 1, text: "uma linha bastante densa de texto para ler depressa" },
      { start: 30, end: 32, text: "Depois." },
    ];
    const out = applyTiming(cues);
    const cps = out[0]!.text.length / (out[0]!.end - out[0]!.start);
    expect(cps).toBeLessThanOrEqual(17 + 1e-6);
  });
});
