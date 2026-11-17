import { describe, it, expect } from "vitest";
import { distinctAuthorNames } from "../../src/services/publication-authors.ts";

describe("distinctAuthorNames", () => {
  it("should list each author of a multi-author publication as its own name", () => {
    const result = distinctAuthorNames([{ authors: ["Buda Śākyamuni (BS)", "Mañjuśrī"] }]);

    expect(result.map((a) => a.name)).toEqual(["Buda Śākyamuni (BS)", "Mañjuśrī"]);
  });

  it("should count how many publications use each name", () => {
    const result = distinctAuthorNames([
      { authors: ["Mañjuśrī"] },
      { authors: ["Mañjuśrī", "Kangyur Rinpoche"] },
    ]);

    expect(result).toEqual([
      { name: "Kangyur Rinpoche", count: 1 },
      { name: "Mañjuśrī", count: 2 },
    ]);
  });

  it("should trim names, drop blanks and count a name once per publication", () => {
    const result = distinctAuthorNames([{ authors: ["  Mañjuśrī ", "", "Mañjuśrī"] }, { authors: null }]);

    expect(result).toEqual([{ name: "Mañjuśrī", count: 1 }]);
  });

  it("should keep spelling variants apart so they can be spotted", () => {
    const result = distinctAuthorNames([{ authors: ["Buda Śākyamuni"] }, { authors: ["Buda Sakyamuni"] }]);

    expect(result).toHaveLength(2);
  });
});
