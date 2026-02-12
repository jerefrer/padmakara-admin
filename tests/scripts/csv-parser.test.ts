import { describe, it, expect } from "vitest";
import {
  parseDateRange,
  parseDuration,
  parseTrackCount,
  parseTeachers,
  parseOrganizations,
  normalizeOrganization,
  teacherAbbreviation,
  parseWixRow,
} from "../../src/scripts/csv-parser.ts";

describe("parseDateRange", () => {
  it("parses single date", () => {
    expect(parseDateRange("2010-03-08")).toEqual({
      startDate: "2010-03-08",
      endDate: "2010-03-08",
    });
  });

  it("parses date range with 'a'", () => {
    expect(parseDateRange("2017-11-14 a 2017-11-20")).toEqual({
      startDate: "2017-11-14",
      endDate: "2017-11-20",
    });
  });

  it("returns null for empty string", () => {
    expect(parseDateRange("")).toEqual({ startDate: null, endDate: null });
  });

  it("returns null for unparseable string", () => {
    expect(parseDateRange("March 2010")).toEqual({ startDate: null, endDate: null });
  });
});

describe("parseDuration", () => {
  it("parses full duration string", () => {
    expect(parseDuration("02h 04min 29s")).toBe(7469);
  });

  it("parses hours and minutes only", () => {
    expect(parseDuration("30h 33min")).toBe(109980);
  });

  it("parses minutes only", () => {
    expect(parseDuration("45min")).toBe(2700);
  });

  it("returns null for empty string", () => {
    expect(parseDuration("")).toBeNull();
  });
});

describe("parseTrackCount", () => {
  it("parses Portuguese track count", () => {
    expect(parseTrackCount("13 Faixas")).toBe(13);
  });

  it("parses large count", () => {
    expect(parseTrackCount("356 Faixas")).toBe(356);
  });

  it("returns 0 for empty string", () => {
    expect(parseTrackCount("")).toBe(0);
  });
});

describe("parseTeachers", () => {
  it("splits pipe-separated teachers", () => {
    expect(
      parseTeachers("Jigme Khyentse Rinpoche | Pema Wangyal Rinpoche | Rangdrol Rinpoche"),
    ).toEqual([
      "Jigme Khyentse Rinpoche",
      "Pema Wangyal Rinpoche",
      "Rangdrol Rinpoche",
    ]);
  });

  it("handles single teacher", () => {
    expect(parseTeachers("Matthieu Ricard")).toEqual(["Matthieu Ricard"]);
  });

  it("returns empty array for empty string", () => {
    expect(parseTeachers("")).toEqual([]);
  });
});

describe("parseOrganizations", () => {
  it("splits and normalizes organizations", () => {
    expect(parseOrganizations("F. Kangyur R. | Songtsen | Stupa | U.B.P.")).toEqual([
      "F. Kangyur Rinpoche",
      "Songtsen",
      "Stupa",
      "U.B.P.",
    ]);
  });

  it("normalizes F. Kangyur R variants", () => {
    expect(parseOrganizations("F. Kangyur R")).toEqual(["F. Kangyur Rinpoche"]);
    expect(parseOrganizations("F. Kangyur R.")).toEqual(["F. Kangyur Rinpoche"]);
    expect(parseOrganizations("F. Kangyur R,")).toEqual(["F. Kangyur Rinpoche"]);
  });

  it("normalizes long-form organization names", () => {
    expect(parseOrganizations("Songtsen - Casa da Cultura do Tibete")).toEqual([
      "Songtsen",
    ]);
    expect(parseOrganizations("U.B.P. - União Budista Portuguesa")).toEqual([
      "U.B.P.",
    ]);
  });
});

describe("normalizeOrganization", () => {
  it("normalizes known variants", () => {
    expect(normalizeOrganization("F. Kangyur R")).toBe("F. Kangyur Rinpoche");
    expect(normalizeOrganization("F. Kangyur R.")).toBe("F. Kangyur Rinpoche");
    expect(normalizeOrganization("Songtsen - Casa da Cultura do Tibete")).toBe("Songtsen");
  });

  it("passes through unknown names", () => {
    expect(normalizeOrganization("Stupa")).toBe("Stupa");
  });
});

describe("teacherAbbreviation", () => {
  it("returns known abbreviations", () => {
    expect(teacherAbbreviation("Jigme Khyentse Rinpoche")).toBe("JKR");
    expect(teacherAbbreviation("Pema Wangyal Rinpoche")).toBe("PWR");
    expect(teacherAbbreviation("Khenchen Pema Sherab Rinpoche")).toBe("KPS");
    expect(teacherAbbreviation("Matthieu Ricard")).toBe("MTR");
  });

  it("returns name as-is for unknown teachers", () => {
    expect(teacherAbbreviation("Unknown Teacher")).toBe("Unknown Teacher");
  });
});

describe("parseWixRow", () => {
  it("parses a minimal row", () => {
    const raw: Record<string, string> = {
      eventCode: "20100308-MTR-CFR-ACM",
      ID: "abc-123",
      teacherName: "Matthieu Ricard",
      "organização": "F. Kangyur Rinpoche",
      "dateStart-dateEnd": "2010-03-08",
      placeTeaching: "Porto, Portugal",
      currentDesignation: "Conferência",
      eventTitle: "A Necessidade de Altruísmo",
      guestName: "",
      mainThemes: "Description text",
      sessionThemes: "",
      eventBiblio: "",
      distributionAudience: "Livre (qualquer pessoa)",
      notes: "",
      OnOff: "false",
      "audio1-language": "Inglês | Português",
      "audio1-duration": "02h 04min 29s",
      "audio1-tracksNo": "13 Faixas",
      "audio1-trackNames": "001 Track one.mp3\n002 Track two.mp3",
      "audio1-Download-URL": "https://example.com/audio1.zip",
      "audio1-EditedStatus": "Faixas",
      "audio2-language": "",
      "audio2-Duration": "",
      "audio2-tracksNo": "",
      "audio2-tracksTitles": "",
      "audio2-Download-URL": "",
      "audio2-EditedStatus": "",
      "transcript1-language": "",
      "transcript1-status": "",
      "transcript1-pages": "",
      "transcript1-PDF-download": "",
      "transcript1-cover-jpg": "",
      "transcript2-language": "",
      "transcript2-status": "",
      "transcrip2-pages": "",
      "transcript2-pdf-download": "",
      "transcript2-cover-jpg": "",
    };

    const result = parseWixRow(raw);
    expect(result.eventCode).toBe("20100308-MTR-CFR-ACM");
    expect(result.wixId).toBe("abc-123");
    expect(result.teacherName).toBe("Matthieu Ricard");
    expect(result.title).toBe("A Necessidade de Altruísmo");
    expect(result.onOff).toBe(false);
    expect(result.audio1.trackNames).toEqual(["001 Track one.mp3", "002 Track two.mp3"]);
    expect(result.audio1.duration).toBe("02h 04min 29s");
    expect(result.audio2.trackNames).toEqual([]);
  });

  it("parses OnOff as boolean", () => {
    const raw: Record<string, string> = {
      OnOff: "true",
      eventCode: "test",
      ID: "",
      teacherName: "",
      "organização": "",
      "dateStart-dateEnd": "",
      placeTeaching: "",
      currentDesignation: "",
      eventTitle: "",
      guestName: "",
      mainThemes: "",
      sessionThemes: "",
      eventBiblio: "",
      distributionAudience: "",
      notes: "",
      "audio1-language": "",
      "audio1-duration": "",
      "audio1-tracksNo": "",
      "audio1-trackNames": "",
      "audio1-Download-URL": "",
      "audio1-EditedStatus": "",
      "audio2-language": "",
      "audio2-Duration": "",
      "audio2-tracksNo": "",
      "audio2-tracksTitles": "",
      "audio2-Download-URL": "",
      "audio2-EditedStatus": "",
      "transcript1-language": "",
      "transcript1-status": "",
      "transcript1-pages": "",
      "transcript1-PDF-download": "",
      "transcript1-cover-jpg": "",
      "transcript2-language": "",
      "transcript2-status": "",
      "transcrip2-pages": "",
      "transcript2-pdf-download": "",
      "transcript2-cover-jpg": "",
    };

    expect(parseWixRow(raw).onOff).toBe(true);
  });
});
