import { describe, it, expect } from "vitest";
import { buildEventFileS3Key } from "../../src/services/s3.ts";
import {
  presignFileSchema,
  createEventFileSchema,
  createTranscriptSchema,
} from "../../src/lib/schemas.ts";

describe("buildEventFileS3Key", () => {
  it("builds events/{code}/{type}/{file}", () => {
    expect(buildEventFileS3Key("EVT-01", "document", "notes.pdf")).toBe(
      "events/EVT-01/document/notes.pdf",
    );
  });
});

describe("event file schemas", () => {
  it("accepts a valid presign-file body", () => {
    const r = presignFileSchema.safeParse({
      eventCode: "EVT-01",
      filename: "slides.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      fileType: "document",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown fileType", () => {
    const r = presignFileSchema.safeParse({
      eventCode: "EVT-01",
      filename: "x.pdf",
      contentType: "application/pdf",
      fileType: "video",
    });
    expect(r.success).toBe(false);
  });

  it("defaults sensitive=false and sortOrder=0 on create", () => {
    const r = createEventFileSchema.parse({
      eventId: 5,
      originalFilename: "photo.jpg",
      s3Key: "events/EVT/image/photo.jpg",
      fileType: "image",
      extension: "jpg",
    });
    expect(r.sensitive).toBe(false);
    expect(r.sortOrder).toBe(0);
  });

  it("defaults transcript status to published", () => {
    const r = createTranscriptSchema.parse({
      eventId: 5,
      language: "en",
      s3Key: "events/EVT/transcripts/t.pdf",
    });
    expect(r.status).toBe("published");
  });
});
