import { describe, expect, it } from "vitest";
import { changedFields } from "./changedFields";

describe("changedFields", () => {
  it("should return only the fields whose value changed", () => {
    expect(changedFields({ a: "x", b: true, c: 1 }, { a: "y", b: true, c: 1 })).toEqual({ a: "y" });
  });

  it("should treat a list rebuilt with the same content as unchanged", () => {
    expect(changedFields({ ids: [{ id: 1, role: "teacher" }] }, { ids: [{ id: 1, role: "teacher" }] })).toEqual({});
  });

  it("should report a list whose content changed", () => {
    expect(changedFields({ ids: [1, 2] }, { ids: [2, 1] })).toEqual({ ids: [2, 1] });
  });

  it("should report a value that became null", () => {
    expect(changedFields<{ d: string | null }>({ d: "2026-01-01" }, { d: null })).toEqual({ d: null });
  });
});
