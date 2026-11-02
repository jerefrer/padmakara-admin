import { describe, expect, it } from "vitest";
import type { Slide } from "@slides/types.ts";
import { renderSlideHtml } from "@slides/render.ts";
import { CANVAS_EDIT_CSS, cleanEditedSpans, onlySpansChanged } from "./slideCanvas";
import { duplicateSlide, patchTextLine } from "./slideDocument";

const slide = (text: string, over: Partial<Slide> = {}): Slide => ({
  id: "s",
  durationMs: 4000,
  fadeMs: 800,
  lines: [
    { id: "a", type: "text", spans: [{ text }], size: "md" },
    { id: "b", type: "text", spans: [{ text: "other" }], size: "lg" },
  ],
  ...over,
});

describe("cleanEditedSpans", () => {
  it("should drop the zero-width space the renderer keeps in an empty line", () => {
    expect(cleanEditedSpans([{ text: "​Hello" }])).toEqual([{ text: "Hello" }]);
  });

  it("should leave one empty span when the line was emptied", () => {
    expect(cleanEditedSpans([{ text: "​" }])).toEqual([{ text: "" }]);
    expect(cleanEditedSpans([])).toEqual([{ text: "" }]);
  });

  it("should keep marks and soft line breaks", () => {
    expect(cleanEditedSpans([{ text: "a\nb", bold: true }])).toEqual([{ text: "a\nb", bold: true }]);
  });
});

describe("onlySpansChanged", () => {
  it("should be true when only the typed line's text differs", () => {
    expect(onlySpansChanged(slide("one"), slide("one two"), "a")).toBe(true);
  });

  it("should be false when another line's text differs", () => {
    expect(onlySpansChanged(slide("one"), slide("one two"), "b")).toBe(false);
  });

  it("should be false when the size changed too", () => {
    const next = patchTextLine({ version: 1, intro: [slide("one")], outro: [] }, "intro", "s", "a", { size: "xl" });
    expect(onlySpansChanged(slide("one"), next.intro[0]!, "a")).toBe(false);
  });

  it("should be false when nothing is being typed", () => {
    expect(onlySpansChanged(slide("one"), slide("one two"), null)).toBe(false);
  });
});

describe("editing render", () => {
  it("should add only editing styles and line ids to the burned markup", () => {
    const s = slide("one");
    const opts = { width: 640, height: 360, fontBaseUrl: "/fonts/", resolveImageUrl: (k: string) => k };
    const burned = renderSlideHtml(s, opts);
    const editing = renderSlideHtml(s, { ...opts, extraCss: CANVAS_EDIT_CSS, lineIds: true });
    expect(editing.replace(CANVAS_EDIT_CSS, "").replace(/ data-line-id="[^"]*"/g, "")).toBe(burned);
    expect(burned).not.toContain("data-line-id");
    expect(editing).toContain('data-line-id="a"');
  });
});

describe("slide document edits used by the toolbar", () => {
  it("should patch size, dim and small caps of one text line only", () => {
    const doc = patchTextLine({ version: 1, intro: [slide("one")], outro: [] }, "intro", "s", "a", {
      size: "xl",
      dim: true,
      smallCaps: true,
    });
    expect(doc.intro[0]!.lines[0]).toMatchObject({ size: "xl", dim: true, smallCaps: true });
    expect(doc.intro[0]!.lines[1]).toMatchObject({ size: "lg" });
  });

  it("should not give a duplicated slide the original's role", () => {
    const doc = duplicateSlide({ version: 1, intro: [slide("one", { role: "session" })], outro: [] }, "intro", "s");
    expect(doc.intro).toHaveLength(2);
    expect(doc.intro[1]!.role).toBeUndefined();
    expect(doc.intro[0]!.role).toBe("session");
  });
});
