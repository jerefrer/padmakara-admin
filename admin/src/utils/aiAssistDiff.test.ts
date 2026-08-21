/**
 * The AI assistant's review table is the only thing standing between an
 * admin and a few hundred applied renames, so what it lists — and how each
 * row is identified — is worth pinning down.
 */

import { describe, expect, it } from "vitest";
import {
  buildEventDiffs,
  buildSessionDiffs,
  buildTrackDiffs,
  buildVideoDiffs,
  inlineDiff,
  selectedResult,
  type AiAssistResult,
  type AiAssistSession,
  type AiAssistTrack,
  type AiAssistVideo,
} from "./aiAssistDiff";

/** Stands in for react-admin's translate: echoes the key, interpolating. */
const t = (key: string, options?: Record<string, unknown>): string => {
  const short = key.replace(/^padmakara\./, "");
  if (options && "number" in options) return `${short}:${String(options.number)}`;
  return short;
};

const track = (over: Partial<AiAssistTrack> & Pick<AiAssistTrack, "rowKey">): AiAssistTrack => ({
  sessionNumber: 1,
  trackNumber: 1,
  originalFilename: "file.mp3",
  title: "Original title",
  titleEn: "",
  titlePt: "",
  speaker: "",
  languages: ["en"],
  ...over,
});

describe("buildTrackDiffs", () => {
  it("labels each row with its zero-padded track number and session", () => {
    const tracks = [track({ rowKey: "a", sessionNumber: 2, trackNumber: 3, title: "Old" })];
    const rows = buildTrackDiffs(tracks, [{ rowKey: "a", titleEn: "New" }], t);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemKey: "a",
      itemLabel: "03",
      itemSubLabel: "Old",
      groupLabel: "session.session:2",
      field: "EN",
      from: "",
      to: "New",
    });
  });

  it("orders rows by session then track, not by the order the AI replied in", () => {
    const tracks = [
      track({ rowKey: "a", sessionNumber: 2, trackNumber: 1 }),
      track({ rowKey: "b", sessionNumber: 1, trackNumber: 9 }),
      track({ rowKey: "c", sessionNumber: 1, trackNumber: 2 }),
    ];
    const rows = buildTrackDiffs(
      tracks,
      [
        { rowKey: "a", titleEn: "A" },
        { rowKey: "b", titleEn: "B" },
        { rowKey: "c", titleEn: "C" },
      ],
      t,
    );

    expect(rows.map((r) => r.itemKey)).toEqual(["c", "b", "a"]);
    expect(rows.map((r) => r.itemLabel)).toEqual(["02", "09", "01"]);
  });

  it("drops a suggestion that matches the value the track already has", () => {
    const tracks = [track({ rowKey: "a", titleEn: "Same", titlePt: "Antes" })];
    const rows = buildTrackDiffs(
      tracks,
      [{ rowKey: "a", titleEn: "Same", titlePt: "Depois" }],
      t,
    );

    expect(rows.map((r) => r.field)).toEqual(["PT"]);
  });

  it("renders the language list with readable names and flags an unmatched speaker", () => {
    const tracks = [track({ rowKey: "a", languages: ["en"], speaker: "" })];
    const rows = buildTrackDiffs(
      tracks,
      [{ rowKey: "a", languages: ["tib", "en"], speaker: "Nobody", speakerUnmatched: true }],
      t,
    );

    const speaker = rows.find((r) => r.field === "fields.speaker");
    expect(speaker).toMatchObject({ from: "", to: "Nobody", unmatched: true });

    const languages = rows.find((r) => r.field === "aiAssist.languages");
    expect(languages).toMatchObject({ from: "English", to: "Tibetan + English" });
  });

  it("falls back to the row key when the track is no longer in the form", () => {
    const rows = buildTrackDiffs([], [{ rowKey: "ghost", titleEn: "New" }], t);

    expect(rows[0]).toMatchObject({ itemLabel: "ghost", from: "", to: "New" });
    expect(rows[0]?.groupLabel).toBeUndefined();
  });
});

describe("buildSessionDiffs", () => {
  it("identifies each row by session number", () => {
    const sessions: AiAssistSession[] = [
      { rowKey: "s1", sessionNumber: 1, titleEn: "One", titlePt: "" },
      { rowKey: "s2", sessionNumber: 2, titleEn: "Two", titlePt: "" },
    ];
    const rows = buildSessionDiffs(
      sessions,
      [{ rowKey: "s2", titleEn: "Second" }, { rowKey: "s1", titlePt: "Primeira" }],
      t,
    );

    expect(rows).toMatchObject([
      { itemKey: "s1", itemLabel: "session.session:1", field: "PT", from: "", to: "Primeira" },
      { itemKey: "s2", itemLabel: "session.session:2", field: "EN", from: "Two", to: "Second" },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["session:s1:titlePt", "session:s2:titleEn"]);
  });
});

describe("buildVideoDiffs", () => {
  it("numbers videos from one and keeps their current title as sub-label", () => {
    const videos: AiAssistVideo[] = [
      { rowKey: "v9", position: 0, title: "raw-upload.mp4", titleEn: "", titlePt: "", videoDate: "" },
    ];
    const rows = buildVideoDiffs(
      videos,
      [{ rowKey: "v9", titleEn: "Opening talk", videoDate: "2026-03-04" }],
      t,
    );

    expect(rows.map((r) => r.field)).toEqual(["EN", "aiAssist.videoDate"]);
    expect(rows[0]).toMatchObject({ itemLabel: "aiAssist.videoLabel:1", itemSubLabel: "raw-upload.mp4" });
  });
});

describe("buildEventDiffs", () => {
  it("lists changed fields in form order with no item column", () => {
    const rows = buildEventDiffs(
      { titleEn: "Old", startDate: "2026-01-01" },
      { startDate: "2026-02-02", titleEn: "New", titlePt: "" },
      t,
    );

    expect(rows).toMatchObject([
      { itemKey: "event", itemLabel: "", field: "events.titleEn", from: "Old", to: "New" },
      { itemKey: "event", itemLabel: "", field: "events.startDate", from: "2026-01-01", to: "2026-02-02" },
    ]);
  });

  it("returns nothing when the AI proposed no event changes", () => {
    expect(buildEventDiffs({ titleEn: "Old" }, undefined, t)).toEqual([]);
  });
});

describe("inlineDiff", () => {
  /** Segments rejoined per side, so a lossless split is easy to assert. */
  const text = (segments: { text: string }[]) => segments.map((seg) => seg.text).join("");
  const changed = (segments: { text: string; changed: boolean }[]) =>
    segments.filter((seg) => seg.changed).map((seg) => seg.text);

  it("flags only the words that moved, leaving the shared ones alone", () => {
    const d = inlineDiff("Dedication of merit part 1", "Dedication of merit, part one");

    expect(changed(d.from)).toEqual(["merit", "1"]);
    expect(changed(d.to)).toEqual(["merit,", "one"]);
    // "Dedication of ... part" is shared, so it stays unhighlighted on both
    // sides — that is the whole point of the word-level pass.
    expect(text(d.from.filter((seg) => !seg.changed))).toBe("Dedication of  part ");
  });

  it("rejoins losslessly, whitespace included", () => {
    const from = "  Morning   teaching ";
    const to = "Morning teaching, revised";
    const d = inlineDiff(from, to);

    expect(text(d.from)).toBe(from);
    expect(text(d.to)).toBe(to);
  });

  it("marks the whole value when one side is empty", () => {
    const d = inlineDiff("", "Brand new title");

    expect(d.from).toEqual([]);
    expect(d.to).toEqual([{ text: "Brand new title", changed: true }]);
  });

  it("marks a wholly different value as changed end to end", () => {
    const d = inlineDiff("alpha", "omega");

    expect(changed(d.from)).toEqual(["alpha"]);
    expect(changed(d.to)).toEqual(["omega"]);
  });

  it("falls back to whole-value marking rather than diffing a huge field", () => {
    const long = Array.from({ length: 600 }, (_, i) => `w${i}`).join(" ");
    const d = inlineDiff(long, `${long} tail`);

    // A 600-word themes field would cost 600x600 cells on every re-render.
    expect(d.from).toHaveLength(1);
    expect(d.to).toHaveLength(1);
    expect(d.to[0]?.changed).toBe(true);
  });
});

describe("selectedResult", () => {
  const tracks: AiAssistTrack[] = [
    track({ rowKey: "a", sessionNumber: 1, trackNumber: 1, titleEn: "One", speaker: "" }),
    track({ rowKey: "b", sessionNumber: 2, trackNumber: 1, titleEn: "Two", speaker: "" }),
  ];
  const result: AiAssistResult = {
    event: { titleEn: "New event title", titlePt: "Novo título" },
    sessions: [],
    videos: [],
    tracks: [
      { rowKey: "a", titleEn: "One revised", speaker: "JKR" },
      { rowKey: "b", titleEn: "Two revised" },
    ],
  };
  const rowsOf = () => [
    ...buildEventDiffs({}, result.event, t),
    ...buildTrackDiffs(tracks, result.tracks, t),
  ];

  it("keeps everything when nothing is unticked", () => {
    const out = selectedResult(result, rowsOf(), new Set());

    expect(out.event).toEqual({ titleEn: "New event title", titlePt: "Novo título" });
    expect(out.tracks).toEqual(result.tracks);
  });

  it("drops just the unticked field, keeping the rest of that track", () => {
    const out = selectedResult(result, rowsOf(), new Set(["track:a:speaker"]));

    expect(out.tracks).toEqual([
      { rowKey: "a", titleEn: "One revised" },
      { rowKey: "b", titleEn: "Two revised" },
    ]);
  });

  it("drops a track entirely once its last field is unticked", () => {
    const out = selectedResult(result, rowsOf(), new Set(["track:b:titleEn"]));

    expect(out.tracks.map((tr) => tr.rowKey)).toEqual(["a"]);
  });

  it("drops the unmatched-speaker flag along with the speaker it belongs to", () => {
    const withFlag: AiAssistResult = {
      ...result,
      tracks: [{ rowKey: "a", speaker: "Nobody", speakerUnmatched: true }],
    };
    const rows = buildTrackDiffs(tracks, withFlag.tracks, t);

    expect(selectedResult(withFlag, rows, new Set(["track:a:speaker"])).tracks).toEqual([]);
  });

  it("leaves out the event key when every event field is unticked", () => {
    const out = selectedResult(
      result,
      rowsOf(),
      new Set(["event:event:titleEn", "event:event:titlePt"]),
    );

    expect(out.event).toBeUndefined();
    expect(out.tracks).toHaveLength(2);
  });

  it("never applies a field the review had no row for", () => {
    // The model echoed titlePt unchanged, so it never reached the table — and
    // must not reach the form either, ticked or not.
    const echoed: AiAssistResult = {
      sessions: [], videos: [],
      tracks: [{ rowKey: "a", titleEn: "One", titlePt: "" }],
    };
    const rows = buildTrackDiffs(tracks, echoed.tracks, t);

    expect(rows).toEqual([]);
    expect(selectedResult(echoed, rows, new Set()).tracks).toEqual([]);
  });
});
