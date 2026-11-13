import { describe, it, expect } from "vitest";
import { parseEmailList } from "../../src/services/email-list.ts";

describe("parseEmailList", () => {
  it("should trim, lowercase and dedupe valid addresses", () => {
    expect(parseEmailList([" A@X.com ", "a@x.com", "b@x.com"])).toEqual({ valid: ["a@x.com", "b@x.com"], invalid: [] });
  });

  it("should report each invalid entry once and skip blanks", () => {
    expect(parseEmailList(["nope", " nope ", "", "  ", "ok@x.com"])).toEqual({ valid: ["ok@x.com"], invalid: ["nope"] });
  });
});
