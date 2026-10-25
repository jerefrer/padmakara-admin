import { describe, expect, it } from "vitest";
import { apiErrorText } from "./apiErrors";

describe("apiErrorText", () => {
  it("should return the API error message when the status text is empty (HTTP/2)", () => {
    expect(apiErrorText("", { error: "Event not found", code: "NOT_FOUND" })).toBe("Event not found");
  });

  it("should list each validation issue with its field path", () => {
    const body = {
      error: "Validation error",
      code: "VALIDATION_ERROR",
      issues: [
        { path: ["eventId"], message: "Invalid input: expected number, received string" },
        { path: ["sessionDate"], message: "Invalid string" },
      ],
    };
    expect(apiErrorText("", body)).toBe(
      "Validation error: eventId: Invalid input: expected number, received string; sessionDate: Invalid string",
    );
  });

  it("should keep the original message when the body carries no error text", () => {
    expect(apiErrorText("Bad Gateway", null)).toBe("Bad Gateway");
  });
});
