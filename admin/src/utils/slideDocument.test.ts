import { describe, expect, it } from "vitest";
import type { SlideDocument } from "@slides/types.ts";
import {
  addLine,
  addSlide,
  deleteLine,
  deleteSlide,
  duplicateSlide,
  moveLine,
  moveSlide,
  newImageLine,
  newSlide,
  newSpacerLine,
  newTextLine,
  replaceLine,
  updateSlide,
} from "./slideDocument";

function emptyDoc(): SlideDocument {
  return { version: 1, intro: [], outro: [] };
}

describe("newSlide / newTextLine / newImageLine / newSpacerLine", () => {
  it("should default a new slide to the shared duration/fade defaults with one empty text line", () => {
    const slide = newSlide();
    expect(slide.durationMs).toBe(4000);
    expect(slide.fadeMs).toBe(800);
    expect(slide.lines).toHaveLength(1);
    expect(slide.lines[0]).toMatchObject({ type: "text", spans: [{ text: "" }], size: "md" });
  });

  it("should generate distinct ids across calls", () => {
    const a = newTextLine();
    const b = newTextLine();
    expect(a.id).not.toBe(b.id);
  });

  it("should build an image line with the given s3Key", () => {
    const line = newImageLine("events/x/images/logo.png");
    expect(line).toMatchObject({ type: "image", s3Key: "events/x/images/logo.png" });
  });

  it("should build a spacer line with no extra fields beyond id/type", () => {
    const line = newSpacerLine();
    expect(line.type).toBe("spacer");
  });
});

describe("addSlide", () => {
  it("should append a new slide to the given sequence only", () => {
    const doc = addSlide(emptyDoc(), "intro");
    expect(doc.intro).toHaveLength(1);
    expect(doc.outro).toHaveLength(0);
  });
});

describe("duplicateSlide", () => {
  it("should insert a copy directly after the source slide with fresh ids", () => {
    const source = newSlide([newTextLine()]);
    const doc: SlideDocument = { version: 1, intro: [source], outro: [] };
    const next = duplicateSlide(doc, "intro", source.id);
    expect(next.intro).toHaveLength(2);
    expect(next.intro[1].id).not.toBe(source.id);
    expect(next.intro[1].lines[0].id).not.toBe(source.lines[0].id);
    // Content is copied verbatim aside from ids.
    expect(next.intro[1].durationMs).toBe(source.durationMs);
  });

  it("should return the document unchanged when the slide id doesn't exist", () => {
    const doc = emptyDoc();
    expect(duplicateSlide(doc, "intro", "missing")).toBe(doc);
  });
});

describe("deleteSlide", () => {
  it("should remove only the targeted slide", () => {
    const a = newSlide();
    const b = newSlide();
    const doc: SlideDocument = { version: 1, intro: [a, b], outro: [] };
    const next = deleteSlide(doc, "intro", a.id);
    expect(next.intro).toEqual([b]);
  });
});

describe("moveSlide", () => {
  it("should swap a slide with its neighbour in the given direction", () => {
    const a = newSlide();
    const b = newSlide();
    const doc: SlideDocument = { version: 1, intro: [a, b], outro: [] };
    const next = moveSlide(doc, "intro", b.id, -1);
    expect(next.intro.map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it("should be a no-op at the start of the list moving up", () => {
    const a = newSlide();
    const doc: SlideDocument = { version: 1, intro: [a], outro: [] };
    const next = moveSlide(doc, "intro", a.id, -1);
    expect(next.intro).toEqual([a]);
  });

  it("should be a no-op at the end of the list moving down", () => {
    const a = newSlide();
    const doc: SlideDocument = { version: 1, intro: [a], outro: [] };
    const next = moveSlide(doc, "intro", a.id, 1);
    expect(next.intro).toEqual([a]);
  });
});

describe("updateSlide", () => {
  it("should patch only durationMs/fadeMs on the targeted slide", () => {
    const a = newSlide();
    const doc: SlideDocument = { version: 1, intro: [a], outro: [] };
    const next = updateSlide(doc, "intro", a.id, { durationMs: 6000 });
    expect(next.intro[0].durationMs).toBe(6000);
    expect(next.intro[0].fadeMs).toBe(a.fadeMs);
  });
});

describe("line operations", () => {
  it("addLine should append to the targeted slide's lines", () => {
    const a = newSlide([]);
    const doc: SlideDocument = { version: 1, intro: [a], outro: [] };
    const line = newTextLine();
    const next = addLine(doc, "intro", a.id, line);
    expect(next.intro[0].lines).toEqual([line]);
  });

  it("deleteLine should remove only the targeted line", () => {
    const l1 = newTextLine();
    const l2 = newTextLine();
    const a = newSlide([l1, l2]);
    const doc: SlideDocument = { version: 1, intro: [a], outro: [] };
    const next = deleteLine(doc, "intro", a.id, l1.id);
    expect(next.intro[0].lines).toEqual([l2]);
  });

  it("moveLine should swap adjacent lines within a slide", () => {
    const l1 = newTextLine();
    const l2 = newTextLine();
    const a = newSlide([l1, l2]);
    const doc: SlideDocument = { version: 1, intro: [a], outro: [] };
    const next = moveLine(doc, "intro", a.id, l2.id, -1);
    expect(next.intro[0].lines.map((l) => l.id)).toEqual([l2.id, l1.id]);
  });

  it("replaceLine should swap a line's full contents while keeping position", () => {
    const l1 = newTextLine();
    const a = newSlide([l1]);
    const doc: SlideDocument = { version: 1, intro: [a], outro: [] };
    const replacement = newImageLine("events/x/images/y.png");
    // replaceLine keeps whatever id is on the replacement value itself.
    const withSameId = { ...replacement, id: l1.id };
    const next = replaceLine(doc, "intro", a.id, l1.id, withSameId);
    expect(next.intro[0].lines).toEqual([withSameId]);
  });
});
