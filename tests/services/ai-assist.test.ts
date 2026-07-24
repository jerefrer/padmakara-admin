import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMessagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: mockMessagesCreate };
  }
  return { default: MockAnthropic };
});

import { aiAssistEvent } from "../../src/services/ai-assist.ts";

const ROSTER = [
  { abbreviation: "JKR", name: "Jigme Khyentse Rinpoche" },
  { abbreviation: "PWR", name: "Pema Wangyal Rinpoche" },
];
const TRACKS = [
  { rowKey: "t1", originalFilename: "001.mp3", title: "opening", speaker: null },
];
const VIDEOS = [{ rowKey: "v1", title: "raw_upload_2025.mp4" }];

function aiReply(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

describe("aiAssistEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns bilingual track title suggestions for a track-only instruction", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ tracks: [
        { rowKey: "t1", titleEn: "Dedication of merit", titlePt: "Dedicação de mérito" },
      ] }),
    );
    const out = await aiAssistEvent({
      instruction: "Fill in English and Portuguese titles", tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.tracks).toEqual([
      { rowKey: "t1", titleEn: "Dedication of merit", titlePt: "Dedicação de mérito" },
    ]);
    expect(out.sessions).toEqual([]);
    expect(out.event).toBeUndefined();
  });

  it("returns a partial track suggestion with only titlePt when just a translation is requested", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ tracks: [{ rowKey: "t1", titlePt: "Praticar a calma mental" }] }),
    );
    const out = await aiAssistEvent({
      instruction: "Translate the track titles to Portuguese", tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.tracks).toEqual([{ rowKey: "t1", titlePt: "Praticar a calma mental" }]);
  });

  it("returns event field suggestions when the instruction asks about the event", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ event: { titleEn: "Spring Retreat 2025" }, tracks: [] }),
    );
    const out = await aiAssistEvent({
      instruction: "Rename the event title to Spring Retreat 2025",
      event: { titleEn: "spring retreat" }, tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.event).toEqual({ titleEn: "Spring Retreat 2025" });
  });

  it("returns session title suggestions", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ sessions: [{ rowKey: "s0", titleEn: "Morning Session" }], tracks: [] }),
    );
    const out = await aiAssistEvent({
      instruction: "Title-case the session titles",
      sessions: [{ rowKey: "s0", titleEn: "morning session" }],
      tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.sessions).toEqual([{ rowKey: "s0", titleEn: "Morning Session" }]);
  });

  it("drops a malformed date but keeps a valid one", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ event: { startDate: "2025-04-12", endDate: "next tuesday" }, tracks: [] }),
    );
    const out = await aiAssistEvent({
      instruction: "Set start date to 12 April 2025",
      event: {}, tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.event).toEqual({ startDate: "2025-04-12" });
  });

  it("resolves a track speaker to its abbreviation and flags unmatched", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ tracks: [
        { rowKey: "t1", speaker: "Jigme Khyentse Rinpoche" },
      ] }),
    );
    const out = await aiAssistEvent({
      instruction: "Set speaker to Jigme", tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.tracks[0]).toMatchObject({ rowKey: "t1", speaker: "JKR" });
    expect(out.tracks[0]?.speakerUnmatched).toBeUndefined();
  });

  it("strips markdown fences around the JSON object", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "```json\n" + JSON.stringify({ tracks: [{ rowKey: "t1", titleEn: "X" }] }) + "\n```" }],
    });
    const out = await aiAssistEvent({
      instruction: "x", tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.tracks).toEqual([{ rowKey: "t1", titleEn: "X" }]);
  });

  it("throws when the AI response is not valid JSON", async () => {
    mockMessagesCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "nope" }] });
    await expect(
      aiAssistEvent({ instruction: "x", tracks: TRACKS, roster: ROSTER, apiKey: "k" }),
    ).rejects.toMatchObject({ statusCode: 422, code: "AI_NEEDS_CLARIFICATION" });
  });

  it("surfaces a transient upstream 5xx as a retryable 503, not a bare 500", async () => {
    // Shape of an Anthropic SDK APIError: an Error carrying a numeric HTTP status.
    const apiError = Object.assign(new Error("Internal server error"), { status: 500 });
    mockMessagesCreate.mockRejectedValueOnce(apiError);
    await expect(
      aiAssistEvent({ instruction: "capitalize titles", tracks: TRACKS, roster: ROSTER, apiKey: "k" }),
    ).rejects.toMatchObject({ statusCode: 503, code: "AI_UNAVAILABLE" });
  });

  it("surfaces an upstream rate limit (429) as a retryable 503", async () => {
    const rateLimited = Object.assign(new Error("rate limited"), { status: 429 });
    mockMessagesCreate.mockRejectedValueOnce(rateLimited);
    await expect(
      aiAssistEvent({ instruction: "x", tracks: TRACKS, roster: ROSTER, apiKey: "k" }),
    ).rejects.toMatchObject({ statusCode: 503, code: "AI_UNAVAILABLE" });
  });
});

/** `count` tracks named t1..tN, the shape the create form sends. */
function manyTracks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    rowKey: `t${i + 1}`,
    originalFilename: `${String(i + 1).padStart(3, "0")}.mp3`,
    title: `track ${i + 1}`,
    speaker: null,
  }));
}

describe("aiAssistEvent batching", () => {
  beforeEach(() => vi.clearAllMocks());

  it("splits a 342-track event across calls and returns every suggestion", async () => {
    // One reply per batch, echoing exactly the rowKeys that batch received.
    mockMessagesCreate.mockImplementation(({ messages }: any) => {
      const data = JSON.parse(messages[0].content.split("Current data:\n")[1]);
      return Promise.resolve(
        aiReply({
          tracks: data.tracks.map((t: any) => ({ rowKey: t.rowKey, titleEn: `EN ${t.rowKey}` })),
        }),
      );
    });

    const out = await aiAssistEvent({
      instruction: "Fill in English titles",
      tracks: manyTracks(342), roster: ROSTER, apiKey: "k",
    });

    expect(mockMessagesCreate).toHaveBeenCalledTimes(7); // ceil(342 / 50)
    expect(out.tracks).toHaveLength(342);
    expect(out.tracks[0]).toEqual({ rowKey: "t1", titleEn: "EN t1" });
    expect(out.tracks[341]).toEqual({ rowKey: "t342", titleEn: "EN t342" });
    // No rowKey appears twice.
    expect(new Set(out.tracks.map((t) => t.rowKey)).size).toBe(342);
  });

  it("makes a single call when the track list fits in one batch", async () => {
    mockMessagesCreate.mockResolvedValueOnce(aiReply({ tracks: [] }));
    await aiAssistEvent({
      instruction: "x", tracks: manyTracks(50), roster: ROSTER, apiKey: "k",
    });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("only lets the first batch change event and session fields", async () => {
    let call = 0;
    mockMessagesCreate.mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        aiReply({
          event: { titleEn: `Title from batch ${call}` },
          sessions: [{ rowKey: "s0", titleEn: `Session from batch ${call}` }],
          tracks: [],
        }),
      );
    });

    const out = await aiAssistEvent({
      instruction: "Rename the event",
      event: { titleEn: "old" },
      sessions: [{ rowKey: "s0", titleEn: "old session" }],
      tracks: manyTracks(120), roster: ROSTER, apiKey: "k",
    });

    expect(out.event).toEqual({ titleEn: "Title from batch 1" });
    expect(out.sessions).toEqual([{ rowKey: "s0", titleEn: "Session from batch 1" }]);
  });

  it("discards a suggestion for a rowKey that was not in the batch", async () => {
    // Batch 2 hallucinates a suggestion for t1, which belongs to batch 1.
    let call = 0;
    mockMessagesCreate.mockImplementation(() => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? aiReply({ tracks: [{ rowKey: "t1", titleEn: "correct" }] })
          : aiReply({ tracks: [{ rowKey: "t1", titleEn: "hallucinated" }] }),
      );
    });

    const out = await aiAssistEvent({
      instruction: "x", tracks: manyTracks(120), roster: ROSTER, apiKey: "k",
    });

    expect(out.tracks).toEqual([{ rowKey: "t1", titleEn: "correct" }]);
  });
});

describe("aiAssistEvent AI reply parsing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses the JSON object when the model prefixes it with a sentence of prose", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: "Sure, here are my suggestions:\n" +
          JSON.stringify({ tracks: [{ rowKey: "t1", titleEn: "Dedication of merit" }] }),
      }],
    });
    const out = await aiAssistEvent({
      instruction: "Fill in English titles", tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.tracks).toEqual([{ rowKey: "t1", titleEn: "Dedication of merit" }]);
  });

  it("parses the JSON object when the model appends prose after it", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: JSON.stringify({ tracks: [{ rowKey: "t1", titleEn: "Dedication of merit" }] }) +
          "\nLet me know if you'd like any other changes.",
      }],
    });
    const out = await aiAssistEvent({
      instruction: "Fill in English titles", tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.tracks).toEqual([{ rowKey: "t1", titleEn: "Dedication of merit" }]);
  });

  it("does not truncate at a brace that appears inside a string value", async () => {
    // A lone, unmatched "}" inside the string value would close a naive
    // (quote-unaware) brace counter early, before the real end of the object.
    const titleEn = "Closing bracket } appears here";
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{
        type: "text",
        text: "Here you go:\n" + JSON.stringify({ tracks: [{ rowKey: "t1", titleEn }] }),
      }],
    });
    const out = await aiAssistEvent({
      instruction: "x", tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.tracks).toEqual([{ rowKey: "t1", titleEn }]);
  });

  it("throws a 422 AI_NEEDS_CLARIFICATION quoting the model's words when the reply is pure prose", async () => {
    const prose = "I need more information: which retreat's sessions should I rename?";
    mockMessagesCreate.mockResolvedValueOnce({ content: [{ type: "text", text: prose }] });
    await expect(
      aiAssistEvent({ instruction: "rename the sessions", tracks: TRACKS, roster: ROSTER, apiKey: "k" }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "AI_NEEDS_CLARIFICATION",
      message: expect.stringContaining("which retreat's sessions should I rename"),
    });
  });

  it("throws a 422 AI_NEEDS_CLARIFICATION when the reply is empty/whitespace only", async () => {
    mockMessagesCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "   \n  " }] });
    await expect(
      aiAssistEvent({ instruction: "x", tracks: TRACKS, roster: ROSTER, apiKey: "k" }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "AI_NEEDS_CLARIFICATION",
      message: expect.stringContaining("empty response"),
    });
  });

  it("truncates a very long prose reply in the error message", async () => {
    const prose = "x".repeat(1000);
    mockMessagesCreate.mockResolvedValueOnce({ content: [{ type: "text", text: prose }] });
    let error: any;
    try {
      await aiAssistEvent({ instruction: "x", tracks: TRACKS, roster: ROSTER, apiKey: "k" });
    } catch (err) {
      error = err;
    }
    expect(error.message.length).toBeLessThan(prose.length);
    // The quoted excerpt ends with the implementation's ellipsis character,
    // immediately followed by the closing curly quote.
    expect(error.message).toContain("…”");
  });
});

describe("aiAssistEvent request shape", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls the claude-opus-5 model with effort medium", async () => {
    mockMessagesCreate.mockResolvedValueOnce(aiReply({ tracks: [] }));
    await aiAssistEvent({ instruction: "x", tracks: TRACKS, roster: ROSTER, apiKey: "k" });
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-opus-5",
        max_tokens: 16000,
        output_config: { effort: "medium" },
      }),
    );
  });
});

describe("aiAssistEvent videos", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns video title suggestions", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({
        videos: [{ rowKey: "v1", titleEn: "Closing Ceremony", titlePt: "Cerimônia de Encerramento" }],
        tracks: [],
      }),
    );
    const out = await aiAssistEvent({
      instruction: "Give the video a readable title",
      videos: VIDEOS, tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.videos).toEqual([
      { rowKey: "v1", titleEn: "Closing Ceremony", titlePt: "Cerimônia de Encerramento" },
    ]);
  });

  it("returns a video date suggestion in ISO form", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ videos: [{ rowKey: "v1", videoDate: "2025-04-12" }], tracks: [] }),
    );
    const out = await aiAssistEvent({
      instruction: "Set the video date to 12 April 2025",
      videos: VIDEOS, tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.videos).toEqual([{ rowKey: "v1", videoDate: "2025-04-12" }]);
  });

  it("drops a non-ISO videoDate while keeping that video's title suggestion", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({
        videos: [{ rowKey: "v1", titleEn: "Closing Ceremony", videoDate: "next tuesday" }],
        tracks: [],
      }),
    );
    const out = await aiAssistEvent({
      instruction: "Title and date the video",
      videos: VIDEOS, tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.videos).toEqual([{ rowKey: "v1", titleEn: "Closing Ceremony" }]);
  });

  it("drops a video suggestion whose rowKey was not in the request payload", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ videos: [{ rowKey: "v999", titleEn: "Hallucinated" }], tracks: [] }),
    );
    const out = await aiAssistEvent({
      instruction: "x",
      videos: VIDEOS, tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.videos).toEqual([]);
  });

  it("drops a video suggestion that carries no changed field", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({ videos: [{ rowKey: "v1" }], tracks: [] }),
    );
    const out = await aiAssistEvent({
      instruction: "x",
      videos: VIDEOS, tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.videos).toEqual([]);
  });

  it("sends videos only in the first batch", async () => {
    const seenVideos: unknown[][] = [];
    mockMessagesCreate.mockImplementation(({ messages }: any) => {
      const data = JSON.parse(messages[0].content.split("Current data:\n")[1]);
      seenVideos.push(data.videos);
      return Promise.resolve(aiReply({ tracks: [] }));
    });

    await aiAssistEvent({
      instruction: "x",
      videos: VIDEOS, tracks: manyTracks(120), roster: ROSTER, apiKey: "k",
    });

    expect(seenVideos).toHaveLength(3); // ceil(120 / 50)
    expect(seenVideos[0]).toEqual(VIDEOS);
    expect(seenVideos[1]).toEqual([]);
    expect(seenVideos[2]).toEqual([]);
  });

  it("returns an empty videos array when the caller passes none", async () => {
    mockMessagesCreate.mockResolvedValueOnce(aiReply({ tracks: [] }));
    const out = await aiAssistEvent({
      instruction: "x", tracks: TRACKS, roster: ROSTER, apiKey: "k",
    });
    expect(out.videos).toEqual([]);
  });
});

describe("aiAssistEvent with empty tracks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("makes exactly one call and still returns event/video suggestions when tracks is []", async () => {
    mockMessagesCreate.mockResolvedValueOnce(
      aiReply({
        event: { titleEn: "Spring Retreat 2025" },
        videos: [{ rowKey: "v1", titleEn: "Closing Ceremony" }],
      }),
    );
    const out = await aiAssistEvent({
      instruction: "Update the event title and video title",
      event: { titleEn: "spring retreat" },
      videos: VIDEOS,
      tracks: [],
      roster: ROSTER,
      apiKey: "k",
    });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(out.event).toEqual({ titleEn: "Spring Retreat 2025" });
    expect(out.videos).toEqual([{ rowKey: "v1", titleEn: "Closing Ceremony" }]);
  });
});
