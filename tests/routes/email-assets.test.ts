import { describe, it, expect } from "vitest";
import { testRequest } from "../helpers.ts";
import { markUrl } from "../../src/services/email-template.ts";

/** The first eight bytes of any PNG. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("GET /api/email-assets", () => {
  it("should serve the mark at the path the emails point at", async () => {
    const path = new URL(markUrl()).pathname;
    const res = await testRequest(path);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual(PNG_MAGIC);
  });

  it("should serve it without a token, because it loads from an inbox", async () => {
    const res = await testRequest("/api/email-assets/mark.png");
    expect(res.status).toBe(200);
  });

  it("should let clients cache it forever", async () => {
    const res = await testRequest("/api/email-assets/mark.png");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("should answer 404 for anything not on the list", async () => {
    for (const name of ["nope.png", "..%2F..%2Fpackage.json"]) {
      const res = await testRequest(`/api/email-assets/${name}`);
      expect(res.status).toBe(404);
    }
  });
});
