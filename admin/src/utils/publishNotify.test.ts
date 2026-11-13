import { describe, expect, it } from "vitest";
import { notifyPublishedBody } from "./publishNotify";

describe("notifyPublishedBody", () => {
  it("should send the message when there is one", () => {
    expect(JSON.parse(notifyPublishedBody({ notify: true, message: "Hello" }))).toEqual({ message: "Hello" });
  });

  it("should send an empty object when there is no message", () => {
    expect(notifyPublishedBody({ notify: true })).toBe("{}");
  });

  it("should send an empty object when the message is blank", () => {
    expect(notifyPublishedBody({ notify: true, message: "  " })).toBe("{}");
  });
});
