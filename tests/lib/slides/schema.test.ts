import { describe, it, expect } from "vitest";
import { slideDocumentSchema } from "../../../src/lib/schemas.ts";

const baseSlide = { id: "s1", durationMs: 4000, fadeMs: 800, lines: [] };

describe("slideDocumentSchema subtitles", () => {
  it("accepts a document saved before subtitles existed", () => {
    const parsed = slideDocumentSchema.parse({ version: 1, intro: [baseSlide], outro: [] });
    expect(parsed.intro[0]?.subtitles).toBeUndefined();
  });

  it("keeps per-language subtitle lines through parsing", () => {
    const parsed = slideDocumentSchema.parse({
      version: 1,
      intro: [{ ...baseSlide, subtitles: { pt: ["Olá", "Mundo"] } }],
      outro: [],
    });
    expect(parsed.intro[0]?.subtitles).toEqual({ pt: ["Olá", "Mundo"] });
  });

  it("rejects subtitle lines that are not strings", () => {
    const result = slideDocumentSchema.safeParse({
      version: 1,
      intro: [{ ...baseSlide, subtitles: { pt: [1] } }],
      outro: [],
    });
    expect(result.success).toBe(false);
  });
});
