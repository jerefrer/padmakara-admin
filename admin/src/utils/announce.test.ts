import { describe, expect, it } from "vitest";
import { announceBody, defaultTicked, type AnnouncementsInfo } from "./announce";

const info = (kinds: Array<Partial<AnnouncementsInfo["kinds"][number]> & { kind: AnnouncementsInfo["kinds"][number]["kind"] }>): AnnouncementsInfo => ({
  recipients: 3,
  published: null,
  kinds: kinds.map((k) => ({ available: true, announcedAt: null, ...k })),
  history: [],
});

describe("defaultTicked", () => {
  it("should tick the available kinds that were not announced yet", () => {
    const ticked = defaultTicked(
      info([
        { kind: "transcripts" },
        { kind: "videos", available: false, reason: "hidden" },
        { kind: "texts", announcedAt: "2026-11-10T10:00:00.000Z" },
      ]),
    );
    expect(ticked).toEqual({ transcripts: true, videos: false, texts: false });
  });

  it("should not tick a kind that is unavailable even if never announced", () => {
    expect(defaultTicked(info([{ kind: "texts", available: false, reason: "empty" }])).texts).toBe(false);
  });
});

describe("announceBody", () => {
  const two = info([
    { kind: "transcripts" },
    { kind: "videos", announcedAt: "2026-11-10T10:00:00.000Z" },
    { kind: "texts" },
  ]);

  it("should send the ticked kinds in order, without force or message", () => {
    expect(announceBody(two, { transcripts: true, videos: false, texts: true }, "")).toEqual({ kinds: ["transcripts", "texts"] });
  });

  it("should add the trimmed message when there is one", () => {
    expect(announceBody(two, { transcripts: true, videos: false, texts: false }, "  Hi  ")).toEqual({
      kinds: ["transcripts"],
      message: "Hi",
    });
  });

  it("should force only when a ticked kind was already announced", () => {
    expect(announceBody(two, { transcripts: false, videos: true, texts: false }, "")).toEqual({
      kinds: ["videos"],
      force: true,
    });
  });

  it("should ignore ticks of unavailable kinds", () => {
    const body = announceBody(info([{ kind: "videos", available: false, reason: "empty" }]), { videos: true }, "");
    expect(body.kinds).toEqual([]);
  });
});
