import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseVtt, serializeVtt, groupIntoSentences, recueSentence } from "../../src/services/subtitle-translate";

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
  tsFindFirstSession,
  tsFindFirstSourceSub,
  tsFindFirstEvent,
  tsMockGetObjectText,
  tsMockPutObject,
  tsMockAddCaption,
} = vi.hoisted(() => {
  // subtitleJobs insert().values().returning() → [{id:"job-1"}]
  const tsInsertReturning = vi.fn(() => Promise.resolve([{ id: "job-1" }]));

  // sessionSubtitles insert().values().onConflictDoUpdate()
  const tsOnConflictDoUpdate = vi.fn(() => Promise.resolve());

  // update().set().where()
  const tsUpdateWhere = vi.fn(() => Promise.resolve());
  const tsUpdateSet = vi.fn(() => ({ where: tsUpdateWhere }));
  const tsUpdate = vi.fn(() => ({ set: tsUpdateSet }));

  // query helpers
  const tsFindFirstSession = vi.fn(() =>
    Promise.resolve({ id: 1, eventId: 1, sessionNumber: 1, bunnyVideoId: "vid" }),
  );
  const tsFindFirstSourceSub = vi.fn(() =>
    Promise.resolve({ language: "en", s3Key: "events/E/subtitles/1/en.vtt" }),
  );
  const tsFindFirstEvent = vi.fn(() => Promise.resolve({ id: 1, eventCode: "E" }));

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
    tsFindFirstSession,
    tsFindFirstSourceSub,
    tsFindFirstEvent,
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
      sessions: { findFirst: tsFindFirstSession },
      sessionSubtitles: { findFirst: tsFindFirstSourceSub },
      events: { findFirst: tsFindFirstEvent },
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
    tsFindFirstSession.mockResolvedValue({ id: 1, eventId: 1, sessionNumber: 1, bunnyVideoId: "vid" });
    tsFindFirstSourceSub.mockResolvedValue({ language: "en", s3Key: "events/E/subtitles/1/en.vtt" });
    tsFindFirstEvent.mockResolvedValue({ id: 1, eventCode: "E" });
    tsInsertReturning.mockResolvedValue([{ id: "job-1" }]);
    tsUpdateWhere.mockResolvedValue(undefined);
    tsOnConflictDoUpdate.mockResolvedValue(undefined);
    tsMockGetObjectText.mockResolvedValue("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello there.\n");
    tsMockPutObject.mockResolvedValue(undefined);
    tsMockAddCaption.mockResolvedValue(undefined);
  });

  it("translateSubtitles produces a target VTT and uploads it", async () => {
    const { translateSubtitles } = await import("../../src/services/subtitle-translate.js");
    const out = await translateSubtitles(1, "fr", "claude-opus-4-8");
    expect(out.s3Key).toContain("/fr.vtt");
    expect(tsMockAddCaption).toHaveBeenCalledWith(
      expect.any(String),
      "fr",
      expect.any(String),
      expect.stringContaining("WEBVTT"),
    );
  });
});
