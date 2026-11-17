import { describe, expect, it } from "vitest";
import { authorKey, canonicalAuthors } from "./AuthorsInput";

describe("authorKey", () => {
  it("should match two spellings that differ only by case, diacritics and spacing", () => {
    expect(authorKey(" Buda  Śākyamuni ")).toBe(authorKey("buda sakyamuni"));
  });
});

describe("canonicalAuthors", () => {
  const suggestions = ["Buda Śākyamuni (BS)", "Mañjuśrī"];

  it("should take the spelling already in use for a typed variant", () => {
    expect(canonicalAuthors(["MANJUSRI"], suggestions)).toEqual(["Mañjuśrī"]);
  });

  it("should keep a new name as typed, trimmed", () => {
    expect(canonicalAuthors(["  Patrul   Rinpoche "], suggestions)).toEqual(["Patrul Rinpoche"]);
  });

  it("should drop blanks and a name entered twice", () => {
    expect(canonicalAuthors(["Mañjuśrī", " ", "manjusri"], suggestions)).toEqual(["Mañjuśrī"]);
  });
});
