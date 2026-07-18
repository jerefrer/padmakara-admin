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
});
