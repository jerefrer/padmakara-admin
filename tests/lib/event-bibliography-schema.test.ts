import { describe, it, expect } from "vitest";
import { updateEventSchema, createEventSchema } from "../../src/lib/schemas.ts";

describe("event bibliography pair", () => {
  it("should accept an English and a Portuguese bibliography on update", () => {
    const out = updateEventSchema.parse({ bibliography: "Book", bibliographyPt: "Livro" });
    expect(out.bibliography).toBe("Book");
    expect(out.bibliographyPt).toBe("Livro");
  });

  it("should accept a null Portuguese bibliography", () => {
    expect(updateEventSchema.parse({ bibliographyPt: null }).bibliographyPt).toBeNull();
  });

  it("should accept the reviewed flags of both languages", () => {
    const out = updateEventSchema.parse({ bibliographyEnReviewed: true, bibliographyPtReviewed: false });
    expect(out.bibliographyPtReviewed).toBe(false);
  });

  it("should not add bibliography keys when none are sent", () => {
    const out = updateEventSchema.parse({ titleEn: "x" });
    expect(Object.keys(out)).not.toContain("bibliographyPt");
  });

  it("should keep bibliographyPt optional on create", () => {
    const base = { eventCode: "E", titleEn: "T", startDate: "2026-01-01", endDate: "2026-01-02" };
    expect(createEventSchema.safeParse(base).success).toBe(true);
  });
});
