import { describe, it, expect } from "vitest";
import {
  normalizeTrackTitle,
  planSessionPairing,
  findPlanCollisions,
  type PairableTrack,
} from "../../src/services/track-pairing.ts";

/** A Tibetan original, as the archive stores them. */
function original(id: number, trackNumber: number, title: string): PairableTrack {
  return { id, trackNumber, title, isTranslation: false, originalLanguage: "tib" };
}

/** Its English translation, numbered one higher by the importer. */
function translation(
  id: number,
  trackNumber: number,
  title: string,
  originalLanguage = "en",
): PairableTrack {
  return { id, trackNumber, title, isTranslation: true, originalLanguage };
}

describe("normalizeTrackTitle", () => {
  it("ignores casing and repeated whitespace", () => {
    expect(normalizeTrackTitle("  Verses  11-12 ")).toBe("verses 11-12");
    expect(normalizeTrackTitle("VERSE 9")).toBe(normalizeTrackTitle("Verse 9"));
  });
});

describe("planSessionPairing", () => {
  it("renumbers a translation onto the original immediately before it", () => {
    const plan = planSessionPairing([
      original(1, 286, "Motivation"),
      translation(2, 287, "Motivation"),
    ]);

    expect(plan.pairs).toEqual([
      { translationId: 2, originalId: 1, fromTrackNumber: 287, toTrackNumber: 286 },
    ]);
    expect(plan.unpaired).toEqual([]);
  });

  it("pairs every consecutive pair in a session and leaves originals alone", () => {
    const plan = planSessionPairing([
      original(1, 285, "Opening prayers glued"),
      original(2, 286, "Motivation"),
      translation(3, 287, "Motivation"),
      original(4, 288, "Chapter 10 verses 4-9"),
      translation(5, 289, "Chapter 10 verses 4-9"),
    ]);

    expect(plan.pairs.map((p) => [p.translationId, p.toTrackNumber])).toEqual([
      [3, 286],
      [5, 288],
    ]);
    expect(plan.unpaired).toEqual([]);
  });

  it("declines when the preceding track has a different title", () => {
    const plan = planSessionPairing([
      original(1, 286, "Motivation"),
      translation(2, 287, "Verse 9"),
    ]);

    expect(plan.pairs).toEqual([]);
    expect(plan.unpaired).toEqual([
      { trackId: 2, trackNumber: 287, title: "Verse 9", reason: "title-differs" },
    ]);
  });

  it("declines a translation that opens a session", () => {
    const plan = planSessionPairing([
      translation(1, 286, "Verse 90 and 91"),
      original(2, 287, "Verse 90 and 91"),
    ]);

    expect(plan.pairs).toEqual([]);
    expect(plan.unpaired[0]?.reason).toBe("no-preceding-track");
  });

  it("declines a second translation of the same original", () => {
    const plan = planSessionPairing([
      original(1, 286, "Verse 88"),
      translation(2, 287, "Verse 88"),
      translation(3, 288, "Verse 88", "pt"),
    ]);

    expect(plan.pairs.map((p) => p.translationId)).toEqual([2]);
    expect(plan.unpaired).toEqual([
      {
        trackId: 3,
        trackNumber: 288,
        title: "Verse 88",
        reason: "preceding-is-a-translation",
      },
    ]);
  });

  it("declines a pair that would collide on the unique constraint", () => {
    const plan = planSessionPairing([
      { id: 1, trackNumber: 286, title: "Morning", isTranslation: false, originalLanguage: "pt" },
      translation(2, 287, "Morning", "pt"),
    ]);

    expect(plan.pairs).toEqual([]);
    expect(plan.unpaired[0]?.reason).toBe("same-language-as-original");
  });

  it("pairs on a shared number even when the titles differ", () => {
    // The older recordings number their pairs together and translate the
    // title: `001 JKR Initial Prayers.mp3` beside `001 TRAD Oracoes
    // Iniciais.mp3`. Nothing moves; only the link is recorded.
    const plan = planSessionPairing([
      { id: 1, trackNumber: 1, title: "Initial Prayers", isTranslation: false, originalLanguage: "en" },
      translation(2, 1, "Oracoes Iniciais", "pt"),
      { id: 3, trackNumber: 2, title: "Introduction", isTranslation: false, originalLanguage: "en" },
      translation(4, 2, "Introdução", "pt"),
    ]);

    expect(plan.pairs).toEqual([
      { translationId: 2, originalId: 1, fromTrackNumber: 1, toTrackNumber: 1 },
      { translationId: 4, originalId: 3, fromTrackNumber: 2, toTrackNumber: 2 },
    ]);
    expect(plan.unpaired).toEqual([]);
  });

  it("declines when two originals of different languages share the number", () => {
    const plan = planSessionPairing([
      { id: 1, trackNumber: 7, title: "Teaching", isTranslation: false, originalLanguage: "tib" },
      { id: 2, trackNumber: 7, title: "Teaching", isTranslation: false, originalLanguage: "en" },
      translation(3, 7, "Ensinamento", "pt"),
    ]);

    expect(plan.pairs).toEqual([]);
    expect(plan.unpaired[0]?.reason).toBe("ambiguous-shared-number");
  });

  it("prefers the shared number over the track immediately before it", () => {
    // Track 2 sits right before track 3 and shares its title, but track 3's
    // own number is already held by track 1 — the stronger evidence.
    const plan = planSessionPairing([
      { id: 1, trackNumber: 5, title: "Refuge", isTranslation: false, originalLanguage: "en" },
      original(2, 4, "Refúgio"),
      translation(3, 5, "Refúgio", "pt"),
    ]);

    expect(plan.pairs).toEqual([
      { translationId: 3, originalId: 1, fromTrackNumber: 5, toTrackNumber: 5 },
    ]);
  });

  it("still records a pair that already shares a number, so it gets the link", () => {
    const plan = planSessionPairing([
      original(1, 286, "Motivation"),
      translation(2, 286, "Motivation"),
    ]);

    expect(plan.pairs).toEqual([
      { translationId: 2, originalId: 1, fromTrackNumber: 286, toTrackNumber: 286 },
    ]);
    expect(plan.unpaired).toEqual([]);
  });

  it("ignores a Portuguese session recording with nothing to pair to", () => {
    const plan = planSessionPairing([
      original(1, 285, "Opening prayers"),
      original(2, 286, "Motivation"),
      translation(3, 287, "Motivation"),
      translation(4, 288, "Manha", "pt"),
    ]);

    // "Manha" follows the English translation, so adjacency rules it out
    // before the titles are even compared — which is the right answer for a
    // whole-session Portuguese recording that translates nothing in
    // particular.
    expect(plan.pairs.map((p) => p.translationId)).toEqual([3]);
    expect(plan.unpaired.map((u) => [u.trackId, u.reason])).toEqual([
      [4, "preceding-is-a-translation"],
    ]);
  });
});

describe("findPlanCollisions", () => {
  it("reports nothing for a plan the rule produced", () => {
    const tracks = [
      original(1, 286, "Motivation"),
      translation(2, 287, "Motivation"),
      original(3, 288, "Verse 9"),
      translation(4, 289, "Verse 9"),
    ];

    expect(findPlanCollisions(tracks, planSessionPairing(tracks))).toEqual([]);
  });

  it("catches two same-language tracks forced onto one number", () => {
    const tracks = [
      original(1, 286, "Motivation"),
      translation(2, 287, "Motivation"),
      translation(3, 290, "Motivation"),
    ];
    const forced = {
      pairs: [
        { translationId: 2, originalId: 1, fromTrackNumber: 287, toTrackNumber: 286 },
        { translationId: 3, originalId: 1, fromTrackNumber: 290, toTrackNumber: 286 },
      ],
      unpaired: [],
    };

    expect(findPlanCollisions(tracks, forced)).toHaveLength(1);
  });
});
