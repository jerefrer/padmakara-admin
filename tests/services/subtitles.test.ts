import { describe, it, expect } from "vitest";
import { captionUploadBody } from "../../src/services/bunny-captions.ts";

describe("captionUploadBody", () => {
  it("base64-encodes the VTT into the Bunny payload", () => {
    const body = captionUploadBody("en", "English", "WEBVTT\n\n");
    expect(body.srclang).toBe("en");
    expect(body.label).toBe("English");
    expect(Buffer.from(body.captionsFile, "base64").toString()).toBe("WEBVTT\n\n");
  });
});
