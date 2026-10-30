import { describe, it, expect } from "vitest";
import {
  formatMonthYear,
  formatLongDate,
  buildDefaultIntro,
  buildDefaultOutro,
  buildDefaultSlideDocument,
  missingSlideInputs,
  isBuiltinKey,
  builtinFilename,
  BUILTIN_PREFIX,
  BUILTIN_LOGO_KEY,
  LOGO_SLIDE_DURATION_MS,
  type IdFactory,
  type SlideTemplateMetadata,
} from "../../../src/lib/slides/defaults.ts";
import { SLIDES_VERSION, lineText, type Slide, type TextLine } from "../../../src/lib/slides/types.ts";

/** Deterministic id factory — a plain counter, so assertions on generated
 *  documents are stable instead of racing real uuids. */
function makeIdFactory(): IdFactory {
  let n = 0;
  return () => `id-${n++}`;
}

/** The example the designer sent: Jigme Khyentse Rinpoche, October 2026. */
const ANDRE_META: SlideTemplateMetadata = {
  teacherNames: ["Jigme Khyentse Rinpoche"],
  titleEn: "Learning to let go and enjoying space",
  titlePt: "Aprender a largar e a apreciar o espaço",
  date: "2026-10-10",
  organizer: "Fundação Kangyur Rinpoche",
  placeName: "Lisbon",
  placeLocation: "Portugal",
  copyrightHolder: "Padmakara Portugal",
  session: { number: 1, total: 4, date: "2026-10-10", period: "morning" },
};

/** Per slide: each line as `[text, style]`, spacers as "—" and images as "[image]". */
function describeSlide(slide: Slide): string[] {
  return slide.lines.map((l) => {
    if (l.type === "spacer") return "—";
    if (l.type === "image") return "[image]";
    const flags = [l.size, l.smallCaps ? "caps" : "", l.spans[0]?.italic ? "italic" : ""].filter(Boolean);
    return `${lineText(l)} (${flags.join(" ")})`;
  });
}

function intro(meta: SlideTemplateMetadata, lang: "en" | "pt" = "en"): string[][] {
  return buildDefaultIntro(meta, makeIdFactory(), lang).map(describeSlide);
}

describe("formatMonthYear", () => {
  it("formats an English month and year", () => {
    expect(formatMonthYear("2026-10-10", "en")).toBe("October 2026");
  });

  it("capitalises the Portuguese month", () => {
    expect(formatMonthYear("2026-10-10", "pt")).toBe("Outubro 2026");
  });

  it.each(["June 21, 2009", "20090621", "", "2009-00-21", "2009-13-21"])("returns null for %j", (value) => {
    expect(formatMonthYear(value, "en")).toBeNull();
  });
});

describe("formatLongDate", () => {
  it("formats an English date without zero-padding the day", () => {
    expect(formatLongDate("2009-06-05", "en")).toBe("5 June 2009");
  });

  it("formats a Portuguese date in lower case with 'de'", () => {
    expect(formatLongDate("2026-10-10", "pt")).toBe("10 de outubro de 2026");
  });

  it("returns null for month 13", () => {
    expect(formatLongDate("2009-13-21", "pt")).toBeNull();
  });
});

describe("buildDefaultIntro — the designer's example", () => {
  it("produces the English sequence", () => {
    expect(intro(ANDRE_META)).toEqual([
      ["[image]", "Padmakara (lg caps)"],
      ["Jigme Khyentse Rinpoche (xl caps)"],
      [
        "Jigme Khyentse Rinpoche (sm caps)",
        "—",
        "—",
        "Learning to let go and enjoying space (xl caps)",
        "—",
        "—",
        "—",
      ],
      ["October 2026 (lg caps)", "Lisbon, Portugal (md italic)"],
      ["Session 1 of 4 (lg caps)", "10 October 2026, morning (md italic)"],
      [
        "Event organized by (sm italic)",
        "Fundação Kangyur Rinpoche (md caps)",
        "—",
        "Video Production (sm italic)",
        "Padmakara Portugal (md caps)",
      ],
    ]);
  });

  it("produces the Portuguese sequence", () => {
    expect(intro(ANDRE_META, "pt")).toEqual([
      ["[image]", "Padmakara (lg caps)"],
      ["Jigme Khyentse Rinpoche (xl caps)"],
      [
        "Jigme Khyentse Rinpoche (sm caps)",
        "—",
        "—",
        "Aprender a largar e a apreciar o espaço (xl caps)",
        "—",
        "—",
        "—",
      ],
      ["Outubro 2026 (lg caps)", "Lisbon, Portugal (md italic)"],
      ["Sessão 1 de 4 (lg caps)", "10 de outubro de 2026, manhã (md italic)"],
      [
        "Evento organizado por (sm italic)",
        "Fundação Kangyur Rinpoche (md caps)",
        "—",
        "Produção de vídeo (sm italic)",
        "Padmakara Portugal (md caps)",
      ],
    ]);
  });

  it("keeps the logo slide short and the others at the default length", () => {
    const slides = buildDefaultIntro(ANDRE_META, makeIdFactory());
    expect(slides[0]?.durationMs).toBe(LOGO_SLIDE_DURATION_MS);
    expect(slides.slice(1).every((s) => s.durationMs === 4000)).toBe(true);
  });

  it("uses the builtin logo, or the supplied one", () => {
    const [first] = buildDefaultIntro(ANDRE_META, makeIdFactory());
    expect(first?.lines[0]).toMatchObject({ type: "image", s3Key: BUILTIN_LOGO_KEY });
    const [custom] = buildDefaultIntro({ ...ANDRE_META, logoS3Key: "events/1/logo.png" }, makeIdFactory());
    expect(custom?.lines[0]).toMatchObject({ s3Key: "events/1/logo.png" });
  });

  it("never mixes the two languages on one card", () => {
    const text = buildDefaultIntro(ANDRE_META, makeIdFactory(), "en")
      .flatMap((s) => s.lines.map((l) => (l.type === "text" ? lineText(l) : "")))
      .join("\n");
    expect(text).not.toContain("|");
    expect(text).not.toContain("Aprender");
  });
});

describe("buildDefaultIntro — omission", () => {
  it("keeps only the logo slide when nothing else is known", () => {
    expect(intro({ teacherNames: [] })).toEqual([["[image]", "Padmakara (lg caps)"]]);
  });

  it("omits the speaker slide without a teacher, and the title slide loses its speaker line", () => {
    const rows = intro({ ...ANDRE_META, teacherNames: [] });
    expect(rows).toHaveLength(5);
    expect(rows[1]).toEqual(["Learning to let go and enjoying space (xl caps)"]);
  });

  it("omits the title slide when the title is missing in the chosen language", () => {
    const rows = intro({ ...ANDRE_META, titlePt: null }, "pt");
    expect(rows).toHaveLength(5);
    expect(rows.flat().join("\n")).not.toContain("largar");
  });

  it("shows the place alone when the date is missing, and the date alone when the place is", () => {
    expect(intro({ ...ANDRE_META, date: null, session: null })[3]).toEqual(["Lisbon, Portugal (md italic)"]);
    expect(intro({ ...ANDRE_META, placeName: null, placeLocation: null })[3]).toEqual(["October 2026 (lg caps)"]);
  });

  it("drops the date slide for an unparseable date", () => {
    const rows = intro({ ...ANDRE_META, date: "soon", placeName: null, placeLocation: null });
    expect(rows.flat().join("\n")).not.toContain("NaN");
    expect(rows).toHaveLength(5);
  });

  it("omits the session slide when the session is unknown", () => {
    const rows = intro({ ...ANDRE_META, session: null });
    expect(rows.flat().join("\n")).not.toContain("Session");
  });

  it("falls back to the metadata date, and omits the period, when the session lacks them", () => {
    const rows = intro({ ...ANDRE_META, session: { number: 2, total: 4 } });
    expect(rows[4]).toEqual(["Session 2 of 4 (lg caps)", "10 October 2026 (md italic)"]);
  });

  it("omits the period word it has no translation for", () => {
    const rows = intro({ ...ANDRE_META, session: { number: 1, total: 4, date: "2026-10-10", period: "dawn" } });
    expect(rows[4]?.[1]).toBe("10 October 2026 (md italic)");
  });

  it("shows only the organizer, or only the production, when the other is missing", () => {
    expect(intro({ ...ANDRE_META, copyrightHolder: null })[5]).toEqual([
      "Event organized by (sm italic)",
      "Fundação Kangyur Rinpoche (md caps)",
    ]);
    expect(intro({ ...ANDRE_META, organizer: null })[5]).toEqual([
      "Video Production (sm italic)",
      "Padmakara Portugal (md caps)",
    ]);
  });

  it("omits the credits slide with neither organizer nor production", () => {
    expect(intro({ ...ANDRE_META, organizer: null, copyrightHolder: null })).toHaveLength(5);
  });
});

describe("buildDefaultIntro — details", () => {
  it("gives each teacher their own xl line, in event order", () => {
    const rows = intro({ teacherNames: ["Tenga Rinpoche", "Jigme Khyentse Rinpoche"] });
    expect(rows[1]).toEqual(["Tenga Rinpoche (xl caps)", "Jigme Khyentse Rinpoche (xl caps)"]);
  });

  it("balances the speaker lines above the title with spacers below it", () => {
    const rows = intro({ teacherNames: ["A", "B"], titleEn: "Title" });
    expect(rows[2]).toEqual(["A (sm caps)", "B (sm caps)", "—", "—", "Title (xl caps)", "—", "—", "—", "—"]);
  });

  it("prefers credit lines over the copyright holder for the video production", () => {
    const rows = intro({ ...ANDRE_META, creditLines: ["Projeto Audio-Video", "Padmakara Lusófona"] });
    expect(rows[5]?.slice(3)).toEqual([
      "Video Production (sm italic)",
      "Projeto Audio-Video (md caps)",
      "Padmakara Lusófona (md caps)",
    ]);
  });

  it("flags every line of text as caps or italic, never both", () => {
    const lines = buildDefaultIntro(ANDRE_META, makeIdFactory()).flatMap((s) => s.lines);
    const text = lines.filter((l): l is TextLine => l.type === "text");
    expect(text.every((l) => Boolean(l.smallCaps) !== Boolean(l.spans[0]?.italic))).toBe(true);
  });
});

describe("missingSlideInputs", () => {
  it("is empty when everything is present", () => {
    expect(missingSlideInputs(ANDRE_META, "en")).toEqual([]);
  });

  it("lists everything for an empty event", () => {
    expect(missingSlideInputs({ teacherNames: [] }, "en")).toEqual([
      "teacher", "title", "date", "place", "session", "organizer", "production",
    ]);
  });

  it("judges the title in the requested language", () => {
    const meta = { ...ANDRE_META, titlePt: " " };
    expect(missingSlideInputs(meta, "en")).toEqual([]);
    expect(missingSlideInputs(meta, "pt")).toEqual(["title"]);
  });

  it("counts an unparseable date as missing", () => {
    expect(missingSlideInputs({ ...ANDRE_META, date: "2026-13-01" }, "en")).toEqual(["date"]);
  });

  it("counts the copyright holder as production, and blank credit lines as nothing", () => {
    expect(missingSlideInputs({ ...ANDRE_META, creditLines: ["  "] }, "en")).toEqual([]);
    expect(missingSlideInputs({ ...ANDRE_META, copyrightHolder: null, creditLines: ["  "] }, "en")).toEqual([
      "production",
    ]);
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
    const doc = buildDefaultSlideDocument(ANDRE_META, makeIdFactory());
    expect(doc.version).toBe(SLIDES_VERSION);
    expect(doc.intro).toHaveLength(6);
    expect(doc.outro).toHaveLength(1);
    expect(doc.outro[0]?.lines[0]).toMatchObject({ type: "image", s3Key: BUILTIN_LOGO_KEY });
  });

  it("generates in Portuguese when asked", () => {
    const doc = buildDefaultSlideDocument(ANDRE_META, makeIdFactory(), "pt");
    expect(doc.intro[4]?.lines.map((l) => lineText(l))[0]).toBe("Sessão 1 de 4");
  });
});

describe("intro subtitles for the other language", () => {
  it("fills Portuguese subtitles on an English intro, slide by slide", () => {
    const slides = buildDefaultIntro(ANDRE_META, makeIdFactory(), "en");
    expect(slides.map((s) => s.subtitles)).toEqual([
      undefined, // logo + wordmark
      undefined, // speaker name reads the same in both languages
      { pt: ["Jigme Khyentse Rinpoche", "Aprender a largar e a apreciar o espaço"] },
      { pt: ["Outubro 2026", "Lisbon, Portugal"] },
      { pt: ["Sessão 1 de 4", "10 de outubro de 2026, manhã"] },
      {
        pt: [
          "Evento organizado por",
          "Fundação Kangyur Rinpoche",
          "Produção de vídeo",
          "Padmakara Portugal",
        ],
      },
    ]);
  });

  it("fills English subtitles on a Portuguese intro", () => {
    const slides = buildDefaultIntro(ANDRE_META, makeIdFactory(), "pt");
    expect(slides[4]?.subtitles).toEqual({ en: ["Session 1 of 4", "10 October 2026, morning"] });
  });

  it("gives the logo slide no subtitles", () => {
    expect(buildDefaultIntro(ANDRE_META, makeIdFactory(), "en")[0]?.subtitles).toBeUndefined();
  });

  it("leaves the outro without subtitles", () => {
    const doc = buildDefaultSlideDocument(ANDRE_META, makeIdFactory());
    expect(doc.outro[0]?.subtitles).toBeUndefined();
  });

  it("hands out the same ids as before for the burned slides", () => {
    const ids = buildDefaultIntro(ANDRE_META, makeIdFactory(), "en").map((s) => s.id);
    expect(ids.every((id) => id.startsWith("id-"))).toBe(true);
  });

  it("omits subtitles for a slide the other language cannot fill", () => {
    const slides = buildDefaultIntro({ ...ANDRE_META, titlePt: null }, makeIdFactory(), "en");
    expect(slides.some((s) => s.subtitles?.pt?.includes("Aprender a largar e a apreciar o espaço"))).toBe(false);
  });
});
