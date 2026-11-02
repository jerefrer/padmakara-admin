import { describe, it, expect } from "vitest";
import { slideDocumentSchema } from "../../../src/lib/schemas.ts";
import { makeClipSlide, sequenceTotalMs } from "../../../src/lib/slides/types.ts";
import { mergeIntroSubtitleCues } from "../../../src/lib/slides/intro-subtitles.ts";

const clip = { id: "c1", kind: "clip", clip: "padmakara-logo-intro", durationMs: 8000, fadeMs: 0, lines: [] };
const plain = { id: "s1", durationMs: 4000, fadeMs: 800, lines: [] };

describe("slideDocumentSchema clip slides", () => {
  it("should accept a built-in clip slide", () => {
    const parsed = slideDocumentSchema.parse({ version: 1, intro: [clip], outro: [] });
    expect(parsed.intro[0]?.clip).toBe("padmakara-logo-intro");
  });

  it("should reject an unknown clip id", () => {
    const doc = { version: 1, intro: [{ ...clip, clip: "nope" }], outro: [] };
    expect(slideDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it("should reject a clip slide without a clip id", () => {
    const { clip: _omit, ...noId } = clip;
    expect(slideDocumentSchema.safeParse({ version: 1, intro: [noId], outro: [] }).success).toBe(false);
  });

  it("should reject a clip id on an ordinary slide", () => {
    const doc = { version: 1, intro: [{ ...plain, clip: "padmakara-logo-intro" }], outro: [] };
    expect(slideDocumentSchema.safeParse(doc).success).toBe(false);
  });
});

describe("clip slides in the intro timeline", () => {
  it("should add the clip's 8 s to the sequence total", () => {
    expect(sequenceTotalMs([makeClipSlide("c", "padmakara-logo-intro"), plain])).toBe(8000 + 5600);
  });

  it("should offset the next slide's subtitle by the clip's 8 s and give the clip none", () => {
    const doc = {
      version: 1,
      intro: [makeClipSlide("c", "padmakara-logo-intro"), { ...plain, subtitles: { pt: ["Olá"] } }],
      outro: [],
    };
    const out = mergeIntroSubtitleCues("WEBVTT\n\n00:01:00.000 --> 00:01:02.000\nHi\n", doc, "pt");
    expect(out).toContain("00:00:08.800 --> 00:00:12.800\nOlá");
    expect(out.match(/-->/g)?.length).toBe(2);
  });
});
