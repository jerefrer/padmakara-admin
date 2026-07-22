import { describe, it, expect } from "vitest";
import { injectSubtitleRenditions, withTimestampMap } from "../../src/routes/media.ts";

const MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=426x240",
  "https://api/media/video/hls/12/v/240p?mat=X",
  "#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=640x360",
  "https://api/media/video/hls/12/v/360p?mat=X",
  "",
].join("\n");

describe("injectSubtitleRenditions", () => {
  it("returns the master unchanged when there are no subtitles", () => {
    expect(injectSubtitleRenditions(MASTER, [], (l) => `u/${l}`)).toBe(MASTER);
  });

  it("adds a SUBTITLES media line per language and tags every variant", () => {
    const out = injectSubtitleRenditions(
      MASTER,
      [{ language: "en", label: "English" }],
      (lang) => `https://api/media/video/hls/12/subs/${lang}/playlist.m3u8?mat=X`,
    );
    expect(out).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs"');
    expect(out).toContain('LANGUAGE="en"');
    expect(out).toContain('NAME="English"');
    expect(out).toContain(
      'URI="https://api/media/video/hls/12/subs/en/playlist.m3u8?mat=X"',
    );
    // Every variant stream must reference the subtitles group.
    const tagged = out.match(/#EXT-X-STREAM-INF:[^\n]*SUBTITLES="subs"/g) ?? [];
    expect(tagged).toHaveLength(2);
    // Media declaration sits right after the #EXTM3U header.
    expect(out.split("\n")[1]).toContain("#EXT-X-MEDIA:TYPE=SUBTITLES");
    // Variant target URLs are untouched.
    expect(out).toContain("https://api/media/video/hls/12/v/240p?mat=X");
  });

  it("falls back to the uppercased language when label is null", () => {
    const out = injectSubtitleRenditions(
      MASTER,
      [{ language: "pt", label: null }],
      (lang) => `u/${lang}`,
    );
    expect(out).toContain('NAME="PT"');
    expect(out).toContain('LANGUAGE="pt"');
  });

  it("emits one media line per language", () => {
    const out = injectSubtitleRenditions(
      MASTER,
      [
        { language: "en", label: "English" },
        { language: "pt", label: "Português" },
      ],
      (lang) => `u/${lang}`,
    );
    const media = out.match(/#EXT-X-MEDIA:TYPE=SUBTITLES/g) ?? [];
    expect(media).toHaveLength(2);
  });
});

describe("withTimestampMap", () => {
  const VTT = ["WEBVTT", "", "00:00:21.120 --> 00:00:22.600", "This morning", ""].join("\n");

  it("inserts the map immediately after the WEBVTT header line", () => {
    const out = withTimestampMap(VTT);
    const lines = out.split("\n");
    expect(lines[0]).toBe("WEBVTT");
    expect(lines[1]).toBe("X-TIMESTAMP-MAP=MPEGTS:131280,LOCAL:00:00:00.000");
    // Blank line still separates the header block from the first cue.
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("00:00:21.120 --> 00:00:22.600");
  });

  it("leaves cue timestamps untouched", () => {
    expect(withTimestampMap(VTT)).toContain("00:00:21.120 --> 00:00:22.600");
  });

  it("is idempotent when a map is already declared", () => {
    const already = withTimestampMap(VTT);
    expect(withTimestampMap(already)).toBe(already);
  });

  it("honours a custom MPEGTS value", () => {
    expect(withTimestampMap(VTT, 900000)).toContain(
      "X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000",
    );
  });

  it("preserves CRLF line endings", () => {
    const crlf = "WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHi\r\n";
    const out = withTimestampMap(crlf);
    expect(out).toContain("WEBVTT\r\nX-TIMESTAMP-MAP=MPEGTS:131280,LOCAL:00:00:00.000\r\n");
  });

  it("still produces a valid document when the header line is missing", () => {
    const out = withTimestampMap("00:00:01.000 --> 00:00:02.000\nHi\n");
    expect(out.startsWith("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:131280")).toBe(true);
  });

  it("emits one media line per language (regression guard)", () => {
    const out = injectSubtitleRenditions(
      MASTER,
      [
        { language: "en", label: "English" },
        { language: "pt", label: "Português" },
      ],
      (lang) => `u/${lang}`,
    );
    const media = out.match(/#EXT-X-MEDIA:TYPE=SUBTITLES/g) ?? [];
    expect(media).toHaveLength(2);
  });
});
