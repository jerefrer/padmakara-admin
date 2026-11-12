import { describe, expect, it } from "vitest";
import { isHiddenWithContent, sectionsToShowOnPublish, topicLineCount, type SectionContent } from "./sectionContent";

const NONE = { audioPublished: false, videoPublished: false, transcriptsPublished: false, textsPublished: false, topicsPublished: false };
const CONTENT: SectionContent = { audioPublished: 12, videoPublished: 0, transcriptsPublished: 6, textsPublished: 0, topicsPublished: 2 };

describe("sectionsToShowOnPublish", () => {
  it("should tick the sections that have content and leave the empty ones unticked", () => {
    expect(sectionsToShowOnPublish(NONE, CONTENT)).toEqual({
      audioPublished: true, videoPublished: false, transcriptsPublished: true, textsPublished: false, topicsPublished: true,
    });
  });

  it("should keep a section ticked when it already was, even without content", () => {
    expect(sectionsToShowOnPublish({ ...NONE, videoPublished: true }, CONTENT).videoPublished).toBe(true);
  });
});

describe("isHiddenWithContent", () => {
  it("should flag a section that has content but is unticked", () => {
    expect(isHiddenWithContent(NONE, CONTENT, "audioPublished")).toBe(true);
  });

  it("should not flag an empty section or a ticked one", () => {
    expect(isHiddenWithContent(NONE, CONTENT, "videoPublished")).toBe(false);
    expect(isHiddenWithContent({ ...NONE, audioPublished: true }, CONTENT, "audioPublished")).toBe(false);
  });
});

describe("topicLineCount", () => {
  it("should count the filled topic and bibliography fields", () => {
    expect(topicLineCount({
      mainThemesEn: "Compassion", mainThemesPt: " ", sessionThemesEn: "", sessionThemesPt: "",
      bibliography: "Shantideva", bibliographyPt: "",
    })).toBe(2);
  });
});
