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
    ).rejects.toThrow();
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
