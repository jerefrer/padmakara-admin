import { describe, it, expect } from "vitest";
import {
  parseGlossary,
  parseHeadwords,
  parseLine,
} from "../../src/scripts/import-padmakara-glossary.ts";

describe("parseLine", () => {
  it("should extract EN and PT headwords from a simple line", () => {
    expect(parseLine("bsod nams|EN merit\\nFR mérite\\nPT mérito")).toEqual({
      wylie: "bsod nams",
      en: ["merit"],
      pt: ["mérito"],
    });
  });

  it("should keep comma-separated variants", () => {
    const e = parseLine("bar do|EN intermediate state, bardo\\nPT estado intermediário, bardo");
    expect(e?.en).toEqual(["intermediate state", "bardo"]);
    expect(e?.pt).toEqual(["estado intermediário", "bardo"]);
  });

  it("should drop definitions and bracketed references", () => {
    const e = parseLine(
      "x|EN four results — Stream enterer, once-returner. [OMS, 2018]\\nPT quatro frutos — Os quatro [CGP, 1997]",
    );
    expect(e?.en).toEqual(["four results"]);
    expect(e?.pt).toEqual(["quatro frutos"]);
  });

  it("should keep a comma inside parentheses within one variant", () => {
    expect(parseHeadwords("refuge (to take, to go), sanctuary")).toEqual([
      "refuge (to take, to go)",
      "sanctuary",
    ]);
  });

  it("should return null when PT is missing", () => {
    expect(parseLine("bad med|EN effortlessly\\nFR sans effort*")).toBeNull();
  });

  it("should return null when EN is missing", () => {
    expect(parseLine("bar ba|PT flamejante\\nIT fiammeggiare")).toBeNull();
  });

  it("should keep identical proper names but skip identical lowercase terms", () => {
    expect(parseLine("zhi ba lha|EN Śāntideva\\nPT Śāntideva")).not.toBeNull();
    expect(parseLine("dri|EN dri\\nPT dri")).toBeNull();
  });

  it("should strip soft hyphens", () => {
    const e = parseLine("x|EN Sarva­nīvaraṇa\\nPT Sarva­nīvaraṇa");
    expect(e?.en).toEqual(["Sarvanīvaraṇa"]);
  });
});

describe("parseGlossary", () => {
  it("should skip invalid lines and deduplicate identical pairs", () => {
    const text = [
      "a|EN merit\\nPT mérito",
      "b|EN merit\\nPT mérito",
      "c|FR only french",
      "",
    ].join("\n");
    expect(parseGlossary(text)).toHaveLength(1);
  });
});
