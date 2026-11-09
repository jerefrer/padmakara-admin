import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.ts", () => ({ db: {} }));
vi.mock("../../src/services/s3.ts", () => ({}));

import { watermarkLine } from "../../src/routes/media.ts";

describe("watermarkLine", () => {
  it("should stamp the reader's full name and email when the profile has a name", () => {
    expect(watermarkLine({ firstName: "Ann", lastName: "Lee" }, "u@test.com")).toBe("Ann Lee — u@test.com");
  });

  it("should stamp the email only once when the profile has no name", () => {
    expect(watermarkLine({ firstName: null, lastName: null }, "u@test.com")).toBe("u@test.com");
  });

  it("should stamp the email only once when the user row is missing", () => {
    expect(watermarkLine(undefined, "u@test.com")).toBe("u@test.com");
  });
});
