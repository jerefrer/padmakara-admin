import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  isPortugueseTrack,
  parseAccentResponse,
  restoreTrackAccents,
} from "../../src/services/pt-accents.ts";
import type { AnalysisResult, AnalysisTrack } from "../../src/services/track-conventions.ts";

function track(filename: string, title: string, languages: string[]): AnalysisTrack {
  return {
    position: 0,
    originalFilename: filename,
    correctedFilename: filename,
    title,
    languages,
    originalLanguage: languages[0] ?? "en",
    isTranslation: languages[0] === "pt",
    speaker: null,
    corrections: [],
  };
}

function result(tracks: AnalysisTrack[]): AnalysisResult {
  return {
    aiCoverage: {
      totalTracks: tracks.length,
      tracksAnalyzedByAi: 0,
      tracksFromDeterministicFallback: tracks.length,
      chunks: 0,
      chunksFailed: 0,
    },
    event: {
      titleEn: null,
      titlePt: null,
      startDate: null,
      endDate: null,
      matchedGroupIds: [],
      matchedTeacherIds: [],
      matchedPlaceIds: [],
      matchedEventTypeId: null,
      folderConventionOk: true,
    },
    sessions: [
      { sessionNumber: 1, titleEn: "", titlePt: "", sessionDate: null, timePeriod: null, tracks },
    ],
    notes: [],
  };
}

/** A client whose single batched call replies with `reply` (or rejects). */
function fakeClient(reply: string | Error) {
  const stream = vi.fn(() => ({
    finalMessage: () =>
      reply instanceof Error
        ? Promise.reject(reply)
        : Promise.resolve({ stop_reason: "end_turn", content: [{ type: "text", text: reply }] }),
  }));
  return { client: { messages: { stream } } as unknown as Anthropic, stream };
}

describe("parseAccentResponse", () => {
  const titles = { t0: "Oracoes iniciais", t1: "Percepcao pura" };

  it("should accept replies that differ from the original only by accents", () => {
    const out = parseAccentResponse('{"t0":"Orações iniciais","t1":"Percepção pura"}', titles);
    expect(out).toEqual({ t0: "Orações iniciais", t1: "Percepção pura" });
  });

  it("should strip markdown fences around the JSON", () => {
    const out = parseAccentResponse('```json\n{"t0":"Orações iniciais"}\n```', titles);
    expect(out).toEqual({ t0: "Orações iniciais" });
  });

  it("should drop an entry whose words were changed", () => {
    const out = parseAccentResponse('{"t0":"Orações finais","t1":"Percepção pura"}', titles);
    expect(out).toEqual({ t1: "Percepção pura" });
  });

  it("should drop an entry whose casing was changed", () => {
    expect(parseAccentResponse('{"t0":"orações iniciais"}', titles)).toEqual({});
  });

  it("should return nothing when the reply is not JSON", () => {
    expect(parseAccentResponse("sorry, no", titles)).toEqual({});
  });
});

describe("isPortugueseTrack", () => {
  it("should be true only when every language is Portuguese", () => {
    expect(isPortugueseTrack({ languages: ["pt"], originalLanguage: "pt" })).toBe(true);
    expect(isPortugueseTrack({ languages: ["en", "pt"], originalLanguage: "en" })).toBe(false);
    expect(isPortugueseTrack({ languages: ["en"], originalLanguage: "en" })).toBe(false);
  });
});

describe("restoreTrackAccents", () => {
  it("should restore accents in one call and flag the titles as AI edits", async () => {
    const pt1 = track("01 Oracoes iniciais.mp3", "Oracoes iniciais", ["pt"]);
    const pt2 = track("02 Percepcao pura.mp3", "Percepcao pura", ["pt"]);
    const done = track("03 Ja acentuado.mp3", "Já acentuado", ["pt"]);
    const en = track("04 Refuge.mp3", "Refuge", ["en"]);
    const { client, stream } = fakeClient(
      '{"t0":"Orações iniciais","t1":"Percepção pura","t2":"Já acentuado"}',
    );

    await restoreTrackAccents(client, result([pt1, pt2, done, en]));

    expect(stream).toHaveBeenCalledTimes(1);
    expect(pt1.title).toBe("Orações iniciais");
    expect(pt1.titlePtAi).toBe(true);
    expect(pt1.corrections).toEqual([
      { field: "title", kind: "accents", before: "Oracoes iniciais", after: "Orações iniciais" },
    ]);
    expect(pt2.title).toBe("Percepção pura");
    expect(done.title).toBe("Já acentuado");
    expect(done.titlePtAi).toBeUndefined();
    expect(en.title).toBe("Refuge");
    expect(en.titlePtAi).toBeUndefined();
  });

  it("should not call the model when there is no Portuguese track", async () => {
    const { client, stream } = fakeClient("{}");
    await restoreTrackAccents(client, result([track("a.mp3", "Refuge", ["en"])]));
    expect(stream).not.toHaveBeenCalled();
  });

  it("should keep the unaccented titles when the model call fails", async () => {
    const pt = track("01 Oracoes iniciais.mp3", "Oracoes iniciais", ["pt"]);
    const { client } = fakeClient(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const out = await restoreTrackAccents(client, result([pt]));

    expect(out.sessions[0]!.tracks[0]!.title).toBe("Oracoes iniciais");
    expect(pt.titlePtAi).toBeUndefined();
    spy.mockRestore();
  });
});
