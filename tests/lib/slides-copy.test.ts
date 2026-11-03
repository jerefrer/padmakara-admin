import { describe, it, expect } from "vitest";
import { copySlidesForSession, detectSessionSlideLanguage } from "../../src/lib/slides/copy.ts";
import { buildDefaultSlideDocument } from "../../src/lib/slides/defaults.ts";
import type { SlideDocument } from "../../src/lib/slides/types.ts";

let n = 0;
const newId = () => `id-${n++}`;

const META = {
  teacherNames: ["A Teacher"],
  titleEn: "Title",
  date: "2026-10-10",
  organizer: "Org",
  session: { number: 1, total: 4, date: "2026-10-10", period: "morning" },
};

describe("generator roles", () => {
  it("should tag every default intro slide with its role", () => {
    const doc = buildDefaultSlideDocument(META, newId, "en");
    expect(doc.intro.map((s) => s.role)).toEqual([
      "logo", "speaker", "title", "date-place", "session", "credits",
    ]);
    expect(doc.outro[0]?.role).toBeUndefined();
  });
});

describe("copySlidesForSession", () => {
  const source = buildDefaultSlideDocument(META, newId, "en");
  // The admin edited the title slide by hand.
  const title = source.intro.find((s) => s.role === "title")!;
  const titleLine = title.lines[0]!;
  if (titleLine.type === "text") titleLine.spans = [{ text: "Hand-edited title" }];

  it("should keep the session slide as edited and flag only it for review", () => {
    const edited = structuredClone(source);
    const sessionLine = edited.intro.find((s) => s.role === "session")!.lines[0]!;
    if (sessionLine.type === "text") sessionLine.spans = [{ text: "Session 1 of 4 (edited)" }];
    const { slides, sessionSlide } = copySlidesForSession(edited, newId);

    expect(sessionSlide).toBe("flagged");
    const texts = slides.intro.map((s) =>
      s.lines.flatMap((l) => (l.type === "text" ? [l.spans.map((p) => p.text).join("")] : [])),
    );
    expect(texts[2]).toEqual(["Hand-edited title"]);
    expect(texts[4]![0]).toBe("Session 1 of 4 (edited)");
    expect(slides.intro.filter((s) => s.needsReview).map((s) => s.role)).toEqual(["session"]);
    expect(slides.intro).toHaveLength(source.intro.length);
  });

  it("should give copied slides and lines fresh ids", () => {
    const { slides } = copySlidesForSession(source, newId);
    const before = new Set(source.intro.flatMap((s) => [s.id, ...s.lines.map((l) => l.id)]));
    const after = slides.intro.flatMap((s) => [s.id, ...s.lines.map((l) => l.id)]);
    expect(after.some((id) => before.has(id))).toBe(false);
  });

  it("should copy a legacy document without roles as is and report the session slide unknown", () => {
    const legacy: SlideDocument = {
      ...source,
      intro: source.intro.map(({ role: _role, ...rest }) => rest),
    };
    const { slides, sessionSlide } = copySlidesForSession(legacy, newId);
    expect(sessionSlide).toBe("unknown");
    expect(slides.intro).toHaveLength(legacy.intro.length);
  });

  it("should detect the language of the session slide", () => {
    expect(detectSessionSlideLanguage(source)).toBe("en");
    expect(detectSessionSlideLanguage(buildDefaultSlideDocument(META, newId, "pt"))).toBe("pt");
  });
});
