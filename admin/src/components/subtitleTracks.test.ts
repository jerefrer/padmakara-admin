import { describe, expect, it } from "vitest";
import {
  buildSubtitleOptions,
  SUBTITLES_OFF,
  type SubtitleTrackDescriptor,
} from "./subtitleTracks";

describe("buildSubtitleOptions", () => {
  it("always leads with an Off option, even with no tracks", () => {
    const options = buildSubtitleOptions([], "Off");
    expect(options).toEqual([{ value: SUBTITLES_OFF, label: "Off" }]);
  });

  it("keeps the caller's Off label (localized)", () => {
    const [off] = buildSubtitleOptions([], "Desligado");
    expect(off).toEqual({ value: SUBTITLES_OFF, label: "Desligado" });
  });

  it("uses the manifest label when present", () => {
    const tracks: SubtitleTrackDescriptor[] = [
      { id: 0, lang: "en", label: "English" },
      { id: 1, lang: "pt", label: "Portuguese" },
    ];
    expect(buildSubtitleOptions(tracks, "Off")).toEqual([
      { value: SUBTITLES_OFF, label: "Off" },
      { value: 0, label: "English" },
      { value: 1, label: "Portuguese" },
    ]);
  });

  it("falls back to the uppercased language when the label is blank", () => {
    const tracks: SubtitleTrackDescriptor[] = [
      { id: 0, lang: "es", label: "" },
      { id: 1, lang: "fr", label: "   " },
      { id: 2, lang: "pt", label: null },
    ];
    expect(buildSubtitleOptions(tracks, "Off").map((o) => o.label)).toEqual([
      "Off",
      "ES",
      "FR",
      "PT",
    ]);
  });

  it("falls back to a numbered label when both label and lang are missing", () => {
    const tracks: SubtitleTrackDescriptor[] = [
      { id: 0, lang: null, label: null },
      { id: 1, lang: "", label: undefined },
    ];
    expect(buildSubtitleOptions(tracks, "Off").map((o) => o.label)).toEqual([
      "Off",
      "Subtitle 1",
      "Subtitle 2",
    ]);
  });

  it("skips non-subtitle native track kinds (metadata, chapters)", () => {
    const tracks: SubtitleTrackDescriptor[] = [
      { id: 0, lang: "en", label: "English", kind: "subtitles" },
      { id: 1, lang: "", label: "Chapters", kind: "chapters" },
      { id: 2, lang: "", label: "cues", kind: "metadata" },
      { id: 3, lang: "pt", label: "Portuguese", kind: "captions" },
    ];
    expect(buildSubtitleOptions(tracks, "Off")).toEqual([
      { value: SUBTITLES_OFF, label: "Off" },
      { value: 0, label: "English" },
      { value: 3, label: "Portuguese" },
    ]);
  });

  it("de-dupes tracks that report the same id", () => {
    const tracks: SubtitleTrackDescriptor[] = [
      { id: 0, lang: "en", label: "English" },
      { id: 0, lang: "en", label: "English (dup)" },
    ];
    expect(buildSubtitleOptions(tracks, "Off")).toEqual([
      { value: SUBTITLES_OFF, label: "Off" },
      { value: 0, label: "English" },
    ]);
  });
});
