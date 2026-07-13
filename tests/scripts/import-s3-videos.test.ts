import { describe, it, expect } from "vitest";
import { parseS3Url, parseVideoName } from "../../src/scripts/import-s3-videos.ts";

describe("parseS3Url", () => {
  it("parses the virtual-hosted-style form (bucket.s3.region.amazonaws.com)", () => {
    expect(
      parseS3Url(
        "https://padmakara-pt-app.s3.eu-west-3.amazonaws.com/Videos_for_app_testing/2009-06-TGR-LIS/2009-06-21-TGR-LIS.mp4",
      ),
    ).toEqual({
      bucket: "padmakara-pt-app",
      region: "eu-west-3",
      key: "Videos_for_app_testing/2009-06-TGR-LIS/2009-06-21-TGR-LIS.mp4",
    });
  });

  it("parses the path-style form (s3.region.amazonaws.com/bucket/key)", () => {
    expect(
      parseS3Url("https://s3.eu-west-3.amazonaws.com/padmakara-pt-app/a/b/c.mp4"),
    ).toEqual({
      bucket: "padmakara-pt-app",
      region: "eu-west-3",
      key: "a/b/c.mp4",
    });
  });

  it("returns null for a non-S3 url", () => {
    expect(parseS3Url("https://example.com/a/b/c.mp4")).toBeNull();
  });

  it("returns null for a malformed url", () => {
    expect(parseS3Url("not-a-url")).toBeNull();
  });
});

describe("parseVideoName", () => {
  it("extracts date only, no period", () => {
    expect(parseVideoName("2009-06-21-TGR-LIS.mp4")).toEqual({
      date: "2009-06-21",
      period: null,
    });
  });

  it("returns date:null for the real-world '20219' typo (regex must not match)", () => {
    // NOTE: "20219-10-09-KPS-TEACHINGS-MORNING-UBP.mp4" has a typo'd 5-digit
    // year segment ("20219" instead of "2019"). The \d{4}-\d{2}-\d{2} regex
    // intentionally does NOT match inside a longer digit run, so this comes
    // back date:null — the operator must supply an explicit `date` hint in
    // the mapping JSON for entries like this.
    expect(parseVideoName("20219-10-09-KPS-TEACHINGS-MORNING-UBP.mp4")).toEqual({
      date: null,
      period: "morning",
    });
  });

  it("extracts date and period (morning) from a well-formed name", () => {
    expect(parseVideoName("2025-04-14-JKR-Mind_Training-Morning-CCA.mp4")).toEqual({
      date: "2025-04-14",
      period: "morning",
    });
  });

  it("returns date:null and period:null when there is no day-level date in the name", () => {
    expect(parseVideoName("2018-07-YMR-LIS.mp4")).toEqual({
      date: null,
      period: null,
    });
  });

  it("extracts period afternoon case-insensitively", () => {
    expect(parseVideoName("2020-01-02-XYZ-AFTERNOON.mp4")).toEqual({
      date: "2020-01-02",
      period: "afternoon",
    });
  });

  it("returns period:null when neither morning nor afternoon appears", () => {
    expect(parseVideoName("2020-01-02-XYZ-EVENING.mp4")).toEqual({
      date: "2020-01-02",
      period: null,
    });
  });
});
