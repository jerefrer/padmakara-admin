import { describe, it, expect } from "vitest";
import {
  glossaryBlock,
  matchGlossary,
  padmakaraGlossaryBlock,
  MAX_GLOSSARY_MATCHES,
} from "../../src/services/glossary.ts";

describe("matchGlossary", () => {
  it("should match diacritic-insensitively when the text drops accents", () => {
    const m = matchGlossary(["Teachings of Shantideva"], "en-to-pt");
    expect(m.map((x) => x.source)).toContain("Śāntideva");
  });

  it("should match the Portuguese source regardless of accents and case", () => {
    const m = matchGlossary(["o mérito"], "pt-to-en");
    expect(m).toContainEqual({ source: "mérito", target: "merit" });
    expect(matchGlossary(["MERITO"], "pt-to-en").map((x) => x.source)).toContain("mérito");
  });

  it("should not match a headword inside a longer word", () => {
    expect(matchGlossary(["meritorious deeds"], "en-to-pt").map((x) => x.source)).not.toContain(
      "merit",
    );
    expect(matchGlossary(["Merit, again"], "en-to-pt").map((x) => x.source)).toContain("merit");
  });

  it("should match multi-word phrases and every variant", () => {
    const m = matchGlossary(["The intermediate state and the bardo"], "en-to-pt");
    const sources = m.map((x) => x.source);
    expect(sources).toContain("intermediate state");
    expect(sources).toContain("bardo");
  });

  it("should not treat a stray abbreviation from comma splitting as a term", () => {
    // "etc" was split out of a headword list and pointed at "atenção plena".
    expect(matchGlossary(["Practices, etc"], "en-to-pt").map((x) => x.source)).not.toContain("etc");
  });

  it("should keep an enumeration whole instead of matching its first word", () => {
    // "King, subjects and companions" must not turn "King" into "Rei / Súbdito e Companheira".
    const king = matchGlossary(["The King"], "en-to-pt").find((x) => x.source === "King");
    expect(king).toBeUndefined();
  });

  it("should return the target variants of the entry", () => {
    const m = matchGlossary(["bardo"], "en-to-pt").find((x) => x.source === "bardo");
    expect(m?.target).toContain("estado intermediário");
  });

  it("should list longer phrases before shorter words", () => {
    const m = matchGlossary(["merit and the intermediate state"], "en-to-pt");
    expect(m[0]?.source).toBe("intermediate state");
  });

  it("should cap the number of matches", () => {
    const text = "merit bardo karma mind emptiness compassion wisdom refuge ".repeat(3);
    expect(matchGlossary([text], "en-to-pt", 2)).toHaveLength(2);
    expect(matchGlossary([text], "en-to-pt").length).toBeLessThanOrEqual(MAX_GLOSSARY_MATCHES);
  });

  it("should return nothing for unrelated text", () => {
    expect(matchGlossary(["zzqx plorp"], "en-to-pt")).toEqual([]);
  });
});

describe("glossaryBlock", () => {
  it("should stay the static block when called without arguments", () => {
    const block = glossaryBlock();
    expect(block).toContain("bodhicitta");
    expect(block).not.toContain("Padmakara glossary");
  });

  it("should append matched lines when texts and direction are given", () => {
    const block = glossaryBlock(["Dedicating merit"], "en-to-pt");
    expect(block).toContain("Padmakara glossary — Padmakara's established translations of Buddhist terms.");
    expect(block).toContain("merit → mérito");
  });

  it("should add nothing when no entry matches", () => {
    expect(glossaryBlock(["zzqx"], "en-to-pt")).toBe(glossaryBlock());
    expect(padmakaraGlossaryBlock(["zzqx"], "pt-to-en")).toBe("");
  });
});
