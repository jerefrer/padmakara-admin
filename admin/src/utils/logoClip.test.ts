import { describe, expect, it } from "vitest";
import type { SlideDocument } from "@slides/types.ts";
import { addLogoClip, deleteSlide, hasLogoClip, newSlide } from "./slideDocument";

describe("logo clip", () => {
  it("should add the clip as the first intro slide", () => {
    const text = newSlide();
    const doc: SlideDocument = { version: 1, intro: [text], outro: [] };
    const next = addLogoClip(doc);
    expect(next.intro).toHaveLength(2);
    expect(next.intro[0]).toMatchObject({ kind: "clip", clip: "padmakara-logo-intro", durationMs: 8000, fadeMs: 0, lines: [] });
    expect(next.intro[1]).toBe(text);
  });

  it("should not add the clip twice", () => {
    const once = addLogoClip({ version: 1, intro: [], outro: [] });
    expect(addLogoClip(once)).toBe(once);
  });

  it("should report no clip once it is deleted, so it can be re-added", () => {
    const once = addLogoClip({ version: 1, intro: [], outro: [] });
    const id = once.intro[0]?.id ?? "";
    const gone = deleteSlide(once, "intro", id);
    expect(hasLogoClip(gone)).toBe(false);
    expect(hasLogoClip(once)).toBe(true);
  });
});
