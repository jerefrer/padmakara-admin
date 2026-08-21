import { describe, it, expect, vi, afterEach } from "vitest";
import {
  formatDateEn,
  formatDatePt,
  buildDefaultIntro,
  buildDefaultOutro,
  buildDefaultSlideDocument,
  isBuiltinKey,
  builtinFilename,
  BUILTIN_PREFIX,
  BUILTIN_LOGO_KEY,
  type IdFactory,
  type SlideTemplateMetadata,
} from "../../../src/lib/slides/defaults.ts";
import { SLIDES_VERSION } from "../../../src/lib/slides/types.ts";

/** Deterministic id factory — a plain counter, so assertions on generated
 *  documents are stable instead of racing real uuids. */
function makeIdFactory(): IdFactory {
  let n = 0;
  return () => `id-${n++}`;
}

/** Full metadata mirroring the reference Tenga Rinpoche intro, used for the
 *  "exact reference sequence" test. */
const FULL_META: SlideTemplateMetadata = {
  teacherNames: ["Tenga Rinpoche"],
  eventTypeEn: "Teachings",
  eventTypePt: "Ensinamentos",
  date: "2009-06-21",
  organizer: "Fundação Kangyur Rinpoche",
  placeName: "Lisboa",
  placeLocation: "Portugal",
  creditLines: ["Projeto Audio-Video"],
  copyrightHolder: "Padmakara Lusófona",
  copyrightYear: 2009,
};

describe("formatDateEn", () => {
  it("formats a valid ISO date in English", () => {
    expect(formatDateEn("2009-06-21")).toBe("21 June 2009");
  });

  it("does not zero-pad the day", () => {
    expect(formatDateEn("2009-06-05")).toBe("5 June 2009");
  });

  it("returns null for a malformed string", () => {
    expect(formatDateEn("June 21, 2009")).toBeNull();
  });

  it("returns null for a string missing dashes", () => {
    expect(formatDateEn("20090621")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(formatDateEn("")).toBeNull();
  });

  it("returns null for month 00", () => {
    expect(formatDateEn("2009-00-21")).toBeNull();
  });

  it("returns null for month 13", () => {
    expect(formatDateEn("2009-13-21")).toBeNull();
  });
});

describe("formatDatePt", () => {
  it("formats a valid ISO date in Portuguese", () => {
    expect(formatDatePt("2009-06-21")).toBe("21 Junho 2009");
  });

  it("returns null for a malformed string", () => {
    expect(formatDatePt("21/06/2009")).toBeNull();
  });

  it("returns null for month 13", () => {
    expect(formatDatePt("2009-13-21")).toBeNull();
  });
});

describe("buildDefaultIntro — full metadata reference sequence", () => {
  it("produces exactly the reference 5-slide sequence", () => {
    const slides = buildDefaultIntro(FULL_META, makeIdFactory());

    expect(slides).toEqual([
      // 1 — teacher, xl
      {
        id: "id-1",
        durationMs: 4000,
        fadeMs: 800,
        lines: [
          {
            id: "id-0",
            type: "text",
            spans: [{ text: "Tenga Rinpoche" }],
            size: "xl",
            dim: false,
          },
        ],
      },
      // 2 — event type, italic, bilingual
      {
        id: "id-3",
        durationMs: 4000,
        fadeMs: 800,
        lines: [
          {
            id: "id-2",
            type: "text",
            spans: [{ text: "Teachings | Ensinamentos", italic: true }],
            size: "lg",
            dim: false,
          },
        ],
      },
      // 3 — date, English then Portuguese, dimmed
      {
        id: "id-6",
        durationMs: 4000,
        fadeMs: 800,
        lines: [
          {
            id: "id-4",
            type: "text",
            spans: [{ text: "21 June 2009" }],
            size: "md",
            dim: true,
          },
          {
            id: "id-5",
            type: "text",
            spans: [{ text: "21 Junho 2009" }],
            size: "md",
            dim: true,
          },
        ],
      },
      // 4 — organizer + em-dash + place
      {
        id: "id-12",
        durationMs: 4000,
        fadeMs: 800,
        lines: [
          {
            id: "id-7",
            type: "text",
            spans: [{ text: "Organizer | Organizador" }],
            size: "sm",
            dim: false,
          },
          {
            id: "id-8",
            type: "text",
            spans: [{ text: "Fundação Kangyur Rinpoche", bold: true }],
            size: "md",
            dim: false,
          },
          {
            id: "id-9",
            type: "text",
            spans: [{ text: "—" }],
            size: "md",
            dim: false,
          },
          {
            id: "id-10",
            type: "text",
            spans: [{ text: "Place | Local" }],
            size: "sm",
            dim: false,
          },
          {
            id: "id-11",
            type: "text",
            spans: [{ text: "Lisboa, Portugal", bold: true }],
            size: "md",
            dim: false,
          },
        ],
      },
      // 5 — credits + spacer + copyright
      {
        id: "id-17",
        durationMs: 4000,
        fadeMs: 800,
        lines: [
          {
            id: "id-13",
            type: "text",
            spans: [
              {
                text: "Camera, archival, and editing | Filmagem, arquivo e edição",
                italic: true,
                bold: true,
              },
            ],
            size: "sm",
            dim: false,
          },
          {
            id: "id-14",
            type: "text",
            spans: [{ text: "Projeto Audio-Video", bold: true }],
            size: "md",
            dim: false,
          },
          { id: "id-15", type: "spacer" },
          {
            id: "id-16",
            type: "text",
            spans: [{ text: "© Padmakara Lusófona, 2009" }],
            size: "sm",
            dim: false,
          },
        ],
      },
    ]);
  });

  it("gives each teacher their own xl line, in event order", () => {
    const [teacherSlide] = buildDefaultIntro(
      { teacherNames: ["Teacher A", "Teacher B"] },
      makeIdFactory(),
    );

    expect(teacherSlide?.lines).toEqual([
      { id: "id-0", type: "text", spans: [{ text: "Teacher A" }], size: "xl", dim: false },
      { id: "id-1", type: "text", spans: [{ text: "Teacher B" }], size: "xl", dim: false },
    ]);
  });
});

describe("buildDefaultIntro — slide omission", () => {
  const base: SlideTemplateMetadata = {
    teacherNames: [],
    eventTypeEn: "Teachings",
    eventTypePt: "Ensinamentos",
    date: "2009-06-21",
    organizer: "Fundação Kangyur Rinpoche",
    placeName: "Lisboa",
    placeLocation: "Portugal",
    creditLines: ["Projeto Audio-Video"],
    copyrightHolder: "Padmakara Lusófona",
  };

  it("omits the teacher slide when teacherNames is empty", () => {
    const slides = buildDefaultIntro(base, makeIdFactory());
    expect(slides).toHaveLength(4);
    expect(slides.some((s) => s.lines.some((l) => l.type === "text" && l.spans[0]?.text === "Tenga Rinpoche"))).toBe(false);
  });

  it("omits the event-type slide when both En and Pt names are absent", () => {
    const slides = buildDefaultIntro(
      { ...base, teacherNames: ["Teacher"], eventTypeEn: undefined, eventTypePt: undefined },
      makeIdFactory(),
    );
    // teacher + date + organizer/place + credits = 4, none italic-only lg line
    expect(slides).toHaveLength(4);
    expect(slides.some((s) => s.lines.some((l) => l.type === "text" && l.size === "lg"))).toBe(false);
  });

  it("omits the date slide when date is absent", () => {
    const slides = buildDefaultIntro({ ...base, teacherNames: ["Teacher"], date: undefined }, makeIdFactory());
    expect(slides).toHaveLength(4);
    // Only the date slide's lines are dim in this metadata, so no dim line
    // surviving is a precise signal the slide itself is gone (a digit-based
    // check would false-positive on the copyright year's "©… 2026" line).
    expect(slides.some((s) => s.lines.some((l) => l.type === "text" && l.dim === true))).toBe(false);
  });

  it("omits the date slide when date is unparseable", () => {
    const slides = buildDefaultIntro({ ...base, teacherNames: ["Teacher"], date: "not-a-date" }, makeIdFactory());
    expect(slides).toHaveLength(4);
  });

  it("omits the organizer/place slide when both organizer and place are absent", () => {
    const slides = buildDefaultIntro(
      { ...base, teacherNames: ["Teacher"], organizer: undefined, placeName: undefined, placeLocation: undefined },
      makeIdFactory(),
    );
    expect(slides).toHaveLength(4);
    expect(slides.some((s) => s.lines.some((l) => l.type === "text" && l.spans[0]?.text === "—"))).toBe(false);
  });

  it("omits the credits slide when both creditLines and copyrightHolder are absent", () => {
    const slides = buildDefaultIntro(
      { ...base, teacherNames: ["Teacher"], creditLines: undefined, copyrightHolder: undefined },
      makeIdFactory(),
    );
    expect(slides).toHaveLength(4);
    expect(slides.some((s) => s.lines.some((l) => l.type === "text" && l.spans[0]?.text.startsWith("©")))).toBe(
      false,
    );
  });

  it("returns an empty array when all metadata is absent", () => {
    expect(buildDefaultIntro({ teacherNames: [] }, makeIdFactory())).toEqual([]);
  });
});

describe("buildDefaultIntro — bilingual event-type line", () => {
  it("joins En and Pt with a pipe when they differ", () => {
    const [slide] = buildDefaultIntro(
      { teacherNames: [], eventTypeEn: "Teachings", eventTypePt: "Ensinamentos" },
      makeIdFactory(),
    );
    expect(slide?.lines[0]).toMatchObject({
      type: "text",
      spans: [{ text: "Teachings | Ensinamentos", italic: true }],
    });
  });

  it("collapses to one name when En and Pt are identical", () => {
    const [slide] = buildDefaultIntro(
      { teacherNames: [], eventTypeEn: "Retreat", eventTypePt: "Retreat" },
      makeIdFactory(),
    );
    expect(slide?.lines[0]).toMatchObject({
      type: "text",
      spans: [{ text: "Retreat", italic: true }],
    });
  });

  it("uses only the English name when Portuguese is absent", () => {
    const [slide] = buildDefaultIntro({ teacherNames: [], eventTypeEn: "Teachings" }, makeIdFactory());
    expect(slide?.lines[0]).toMatchObject({ spans: [{ text: "Teachings", italic: true }] });
  });

  it("uses only the Portuguese name when English is absent", () => {
    const [slide] = buildDefaultIntro({ teacherNames: [], eventTypePt: "Ensinamentos" }, makeIdFactory());
    expect(slide?.lines[0]).toMatchObject({ spans: [{ text: "Ensinamentos", italic: true }] });
  });
});

describe("buildDefaultIntro — em-dash rule", () => {
  it("inserts the em-dash line only when both organizer and place exist", () => {
    const [slide] = buildDefaultIntro(
      { teacherNames: [], organizer: "Org", placeName: "City", placeLocation: "Country" },
      makeIdFactory(),
    );
    const dashLines = slide?.lines.filter((l) => l.type === "text" && l.spans[0]?.text === "—");
    expect(dashLines).toHaveLength(1);
  });

  it("omits the em-dash when only organizer is present", () => {
    const [slide] = buildDefaultIntro({ teacherNames: [], organizer: "Org" }, makeIdFactory());
    expect(slide?.lines).toHaveLength(2);
    expect(slide?.lines.some((l) => l.type === "text" && l.spans[0]?.text === "—")).toBe(false);
  });

  it("omits the em-dash when only place is present", () => {
    const [slide] = buildDefaultIntro({ teacherNames: [], placeName: "City" }, makeIdFactory());
    expect(slide?.lines).toHaveLength(2);
    expect(slide?.lines.some((l) => l.type === "text" && l.spans[0]?.text === "—")).toBe(false);
  });
});

describe("buildDefaultIntro — copyright year", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the given copyrightYear when provided", () => {
    const [slide] = buildDefaultIntro(
      { teacherNames: [], copyrightHolder: "Padmakara", copyrightYear: 1999 },
      makeIdFactory(),
    );
    const line = slide?.lines.find((l) => l.type === "text" && l.spans[0]?.text.startsWith("©"));
    expect(line).toMatchObject({ spans: [{ text: "© Padmakara, 1999" }] });
  });

  it("defaults to the current year when copyrightYear is omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T00:00:00Z"));

    const [slide] = buildDefaultIntro({ teacherNames: [], copyrightHolder: "Padmakara" }, makeIdFactory());
    const line = slide?.lines.find((l) => l.type === "text" && l.spans[0]?.text.startsWith("©"));
    expect(line).toMatchObject({ spans: [{ text: "© Padmakara, 2026" }] });
  });
});

describe("buildDefaultOutro", () => {
  it("falls back to the builtin logo key when no logoS3Key is supplied", () => {
    const slides = buildDefaultOutro({ teacherNames: [] }, makeIdFactory());
    expect(slides).toEqual([
      {
        id: "id-1",
        durationMs: 4000,
        fadeMs: 800,
        lines: [{ id: "id-0", type: "image", s3Key: BUILTIN_LOGO_KEY, alt: "Padmakara" }],
      },
    ]);
  });

  it("uses an explicitly supplied logo key over the builtin", () => {
    const slides = buildDefaultOutro({ teacherNames: [], logoS3Key: "events/123/logo.png" }, makeIdFactory());
    expect(slides[0]?.lines[0]).toEqual({
      id: "id-0",
      type: "image",
      s3Key: "events/123/logo.png",
      alt: "Padmakara",
    });
  });

  it("falls back to the builtin when logoS3Key is blank", () => {
    const slides = buildDefaultOutro({ teacherNames: [], logoS3Key: "   " }, makeIdFactory());
    expect(slides[0]?.lines[0]).toMatchObject({ s3Key: BUILTIN_LOGO_KEY });
  });

  it("always returns exactly one slide with one image line (never empty)", () => {
    const slides = buildDefaultOutro({ teacherNames: [] }, makeIdFactory());
    expect(slides).toHaveLength(1);
    expect(slides[0]?.lines).toHaveLength(1);
    expect(slides[0]?.lines[0]?.type).toBe("image");
  });
});

describe("isBuiltinKey / builtinFilename", () => {
  it("recognises a builtin-prefixed key", () => {
    expect(isBuiltinKey(BUILTIN_LOGO_KEY)).toBe(true);
    expect(isBuiltinKey(`${BUILTIN_PREFIX}another-asset.svg`)).toBe(true);
  });

  it("rejects a normal S3 key", () => {
    expect(isBuiltinKey("events/123/logo.png")).toBe(false);
  });

  it("rejects a key that merely contains the prefix mid-string", () => {
    expect(isBuiltinKey(`events/${BUILTIN_PREFIX}logo.png`)).toBe(false);
  });

  it("extracts the filename portion of a builtin key", () => {
    expect(builtinFilename(BUILTIN_LOGO_KEY)).toBe("padmakara-logo.png");
  });
});

describe("buildDefaultSlideDocument", () => {
  it("assembles version, intro, and outro from the same id factory", () => {
    const doc = buildDefaultSlideDocument(FULL_META, makeIdFactory());
    expect(doc.version).toBe(SLIDES_VERSION);
    expect(doc.intro).toHaveLength(5);
    expect(doc.outro).toHaveLength(1);
    expect(doc.outro[0]?.lines[0]).toMatchObject({ type: "image", s3Key: BUILTIN_LOGO_KEY });
  });
});
