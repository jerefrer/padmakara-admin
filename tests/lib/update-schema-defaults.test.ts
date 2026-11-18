import { describe, it, expect } from "vitest";
import {
  createAudienceSchema,
  createEventSchema,
  createEventTypeSchema,
  createPublicationSchema,
  createTranscriptSchema,
  updateAudienceSchema,
  updateEventSchema,
  updateEventTypeSchema,
  updatePublicationSchema,
  updateTranscriptSchema,
} from "../../src/lib/schemas.ts";

// Zod 4 `.partial()` keeps the defaults of the create schema, so a one-field update
// would come back with the other defaulted fields set and overwrite the stored values.

describe("updatePublicationSchema", () => {
  it("should leave every defaulted field out when the body sends only a title", () => {
    const data = updatePublicationSchema.parse({ title: "x" });

    expect(data).toEqual({ title: "x" });
  });

  it("should keep authors, language and the id lists when the body sends them", () => {
    const body = { authors: ["A"], language: "en", eventIds: [1], retreatGroupIds: [2], accessUserIds: [3] };

    expect(updatePublicationSchema.parse(body)).toEqual(body);
  });

  it("should still default them on create", () => {
    const data = createPublicationSchema.parse({ title: "x", pdfS3Key: "k.pdf", audienceId: 1 });

    expect(data).toMatchObject({ authors: [], language: "pt", eventIds: [], retreatGroupIds: [], accessUserIds: [] });
  });
});

describe("updateEventTypeSchema", () => {
  it("should leave displayOrder out when the body omits it", () => {
    expect(updateEventTypeSchema.parse({ nameEn: "Retreat" })).toEqual({ nameEn: "Retreat" });
  });

  it("should still default displayOrder to 0 on create", () => {
    const data = createEventTypeSchema.parse({ nameEn: "Retreat", abbreviation: "R", slug: "retreat" });

    expect(data.displayOrder).toBe(0);
  });
});

describe("updateAudienceSchema", () => {
  it("should leave displayOrder out when the body omits it", () => {
    expect(updateAudienceSchema.parse({ nameEn: "Members" })).toEqual({ nameEn: "Members" });
  });

  it("should still default displayOrder to 0 on create", () => {
    expect(createAudienceSchema.parse({ nameEn: "Members", slug: "members" }).displayOrder).toBe(0);
  });
});

describe("updateEventSchema", () => {
  it("should leave status and the id lists out when the body sends only a title", () => {
    expect(updateEventSchema.parse({ titleEn: "x" })).toEqual({ titleEn: "x" });
  });

  it("should keep the teacher role default inside a sent teacher entry", () => {
    const data = updateEventSchema.parse({ teacherIds: [{ id: 5 }] });

    expect(data.teacherIds).toEqual([{ id: 5, role: "teacher" }]);
  });

  it("should still default status and the id lists on create", () => {
    const data = createEventSchema.parse({
      eventCode: "E",
      titleEn: "x",
      startDate: "2026-01-01",
      endDate: "2026-01-02",
    });

    expect(data).toMatchObject({ status: "draft", teacherIds: [], groupIds: [], placeIds: [], organizerIds: [], publicationIds: [] });
  });
});

describe("updateTranscriptSchema", () => {
  it("should leave status, published and isExcerpt out when the body sends only a language", () => {
    expect(updateTranscriptSchema.parse({ language: "pt" })).toEqual({ language: "pt" });
  });

  it("should keep the one field the body sends", () => {
    expect(updateTranscriptSchema.parse({ published: true })).toEqual({ published: true });
  });

  it("should refuse a status outside the vocabulary", () => {
    expect(updateTranscriptSchema.safeParse({ status: "published" }).success).toBe(false);
  });

  it("should refuse a language outside en, pt, fr and tib", () => {
    expect(updateTranscriptSchema.safeParse({ language: "es" }).success).toBe(false);
  });
});

describe("createTranscriptSchema", () => {
  it("should default to a final, full, unpublished file", () => {
    const data = createTranscriptSchema.parse({ eventId: 1, language: "en", s3Key: "k.pdf" });

    expect(data).toMatchObject({ status: "final", isExcerpt: false, published: false });
  });
});
