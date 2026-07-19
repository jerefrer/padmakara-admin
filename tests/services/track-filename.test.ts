import { describe, expect, it } from "vitest";
import {
  buildConventionFilename,
  buildSessionMarker,
  type SessionNameInfo,
  type TrackNameInfo,
} from "../../src/services/track-filename.ts";
import { parseTrackFilename } from "../../src/services/track-parser.ts";

const SESSION: SessionNameInfo = {
  sessionDate: "2025-04-17",
  timePeriod: "morning",
  partNumber: null,
};

const NO_SESSION: SessionNameInfo = {
  sessionDate: null,
  timePeriod: null,
  partNumber: null,
};

function track(overrides: Partial<TrackNameInfo> = {}): TrackNameInfo {
  return {
    trackNumber: 6,
    title: "Relative and absolute means",
    speaker: "JKR",
    languages: ["en"],
    isTranslation: false,
    s3Key: "events/X/006.mp3",
    ...overrides,
  };
}

describe("buildSessionMarker", () => {
  it("should format day, English month and AM from an ISO morning session", () => {
    expect(buildSessionMarker(SESSION)).toBe("(17 April AM)");
  });

  it("should format PM for afternoon and evening sessions", () => {
    expect(buildSessionMarker({ ...SESSION, timePeriod: "afternoon" })).toBe("(17 April PM)");
    expect(buildSessionMarker({ ...SESSION, timePeriod: "evening" })).toBe("(17 April PM)");
  });

  it("should include the part number when the session has one", () => {
    expect(buildSessionMarker({ ...SESSION, partNumber: 2 })).toBe("(17 April AM part 2)");
  });

  it("should return empty when the date or period is missing", () => {
    expect(buildSessionMarker(NO_SESSION)).toBe("");
    expect(buildSessionMarker({ ...SESSION, timePeriod: null })).toBe("");
    expect(buildSessionMarker({ ...SESSION, sessionDate: "April 17" })).toBe("");
  });
});

describe("buildConventionFilename", () => {
  it("should name an English original with speaker and session marker", () => {
    expect(buildConventionFilename(track(), SESSION)).toBe(
      "006 JKR - Relative and absolute means (17 April AM).mp3",
    );
  });

  it("should name a Portuguese translation without speaker using TRAD", () => {
    const name = buildConventionFilename(
      track({ speaker: null, languages: ["pt"], isTranslation: true, title: "Meios relativos e absolutos" }),
      SESSION,
    );
    expect(name).toBe("006 TRAD - Meios relativos e absolutos (17 April AM).mp3");
  });

  it("should keep the speaker on a Portuguese translation via the [POR] tag", () => {
    const name = buildConventionFilename(
      track({ languages: ["pt"], isTranslation: true, title: "Meios relativos" }),
      SESSION,
    );
    expect(name).toBe("006 JKR [POR] Meios relativos (17 April AM).mp3");
  });

  it("should tag multi-language files with + in stored order", () => {
    const name = buildConventionFilename(
      track({ speaker: "CNR", languages: ["tib", "en"] }),
      NO_SESSION,
    );
    expect(name).toBe("006 CNR [TIB+ENG] Relative and absolute means.mp3");
  });

  it("should keep the real audio extension and pad the number to 3 digits", () => {
    const name = buildConventionFilename(
      track({ trackNumber: 7, s3Key: "events/X/some file.M4A" }),
      NO_SESSION,
    );
    expect(name).toBe("007 JKR - Relative and absolute means.m4a");
  });

  it("should strip bracket and filesystem-unsafe characters from the title", () => {
    const name = buildConventionFilename(
      track({ title: 'Ques[tion]s: "why?" <a/b>' }),
      NO_SESSION,
    );
    expect(name).toBe("006 JKR - Questions why ab.mp3");
  });

  describe("round-trips through parseTrackFilename", () => {
    const cases: Array<{ label: string; track: TrackNameInfo; session: SessionNameInfo }> = [
      { label: "English original with speaker", track: track(), session: SESSION },
      { label: "English original without speaker", track: track({ speaker: null }), session: SESSION },
      {
        label: "English translation",
        track: track({ languages: ["en"], isTranslation: true }),
        session: SESSION,
      },
      {
        label: "Portuguese translation without speaker",
        track: track({ speaker: null, languages: ["pt"], isTranslation: true, title: "Pratica diaria" }),
        session: SESSION,
      },
      {
        label: "Portuguese translation with speaker",
        track: track({ languages: ["pt"], isTranslation: true, title: "Pratica diaria" }),
        session: SESSION,
      },
      {
        label: "Tibetan original",
        track: track({ speaker: "KPS", languages: ["tib"] }),
        session: SESSION,
      },
      {
        label: "bilingual EN+PT single file",
        track: track({ languages: ["en", "pt"] }),
        session: { ...SESSION, timePeriod: "afternoon" },
      },
      {
        label: "trilingual file without speaker",
        track: track({ speaker: null, languages: ["tib", "en", "pt"] }),
        session: { ...SESSION, partNumber: 3 },
      },
    ];

    for (const { label, track: t, session: s } of cases) {
      it(`should round-trip: ${label}`, () => {
        const filename = buildConventionFilename(t, s);
        const parsed = parseTrackFilename(filename);

        expect(parsed.trackNumber).toBe(t.trackNumber);
        expect(parsed.speaker).toBe(t.speaker);
        expect(parsed.languages).toEqual(t.languages);
        expect(parsed.isTranslation).toBe(t.isTranslation);
        expect(parsed.title).toBe(t.title);
        // "(17 April AM)" → "April 17" + morning/afternoon
        expect(parsed.date).toBe("April 17");
        expect(parsed.timePeriod).toBe(s.timePeriod === "morning" ? "morning" : "afternoon");
        expect(parsed.partNumber).toBe(s.partNumber);
      });
    }

    it("should round-trip without a session marker", () => {
      const parsed = parseTrackFilename(buildConventionFilename(track(), NO_SESSION));
      expect(parsed.trackNumber).toBe(6);
      expect(parsed.speaker).toBe("JKR");
      expect(parsed.title).toBe("Relative and absolute means");
      expect(parsed.date).toBeNull();
      expect(parsed.timePeriod).toBeNull();
    });
  });
});
