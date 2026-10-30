import { describe, expect, it } from "vitest";
import { splitDuplicateFiles } from "./duplicateFiles";

const f = (name: string, size: number) => ({ name, size });

describe("splitDuplicateFiles", () => {
  it("should keep every file when nothing exists yet", () => {
    const r = splitDuplicateFiles([f("a.pdf", 1), f("b.pdf", 2)], []);
    expect(r.fresh).toHaveLength(2);
    expect(r.duplicates).toHaveLength(0);
  });

  it("should skip a file with the same name and size as an existing one", () => {
    const r = splitDuplicateFiles([f("a.pdf", 1)], [f("a.pdf", 1)]);
    expect(r.fresh).toHaveLength(0);
    expect(r.duplicates).toEqual([f("a.pdf", 1)]);
  });

  it("should keep a file with the same name but a different size", () => {
    const r = splitDuplicateFiles([f("a.pdf", 2)], [f("a.pdf", 1)]);
    expect(r.fresh).toHaveLength(1);
  });

  it("should skip the repeats within a single drop and keep the first", () => {
    const r = splitDuplicateFiles([f("a.pdf", 1), f("a.pdf", 1), f("a.pdf", 1)], []);
    expect(r.fresh).toHaveLength(1);
    expect(r.duplicates).toHaveLength(2);
  });
});
