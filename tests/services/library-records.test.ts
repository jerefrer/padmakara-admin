import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import {
  parseLibraryCsv,
  LibraryCsvError,
  fold,
  searchRecords,
  suggestRecords,
  mapRecordToEvent,
  detectLanguage,
  type MappingRef,
} from "../../src/services/library-records.ts";

// The real exports live outside the repo (they hold the association's data);
// those tests run wherever the files are present.
const LATEST = "/Users/jeremy/Downloads/libraryEvent.csv";
const SAMPLE = "/Users/jeremy/Downloads/libraryEvent 20250821.csv";

const HEADER = "ID,eventCode,eventTitle,teacherName,guestName,organização,dateStart-dateEnd,placeTeaching,currentDesignation,distributionAudience,mainThemes,sessionThemes,eventBiblio,notes";
function csv(...rows: string[]): string {
  return "﻿" + [HEADER, ...rows].join("\n");
}
const SHANTIDEVA =
  'w1,20191006_12-KPS-ENS-UBP,"O Nono Capítulo, Parte 3",Khenchen Pema Sherab Rinpoche,Wulstan Fletcher,F. Kangyur R. | Songtsen,2019-10-06 a 2019-10-12,"UBP, Av. 5 de Outubro, Lisboa, Portugal",Ensinamento,Participantes no evento,"Tema com\nvárias linhas","Śāntideva | Day 1",Bibliografia,"Completo e Revisto"';
const SAMATHA =
  'w2,20161105_08-JKR-PWR-SHA-HSA,Retiro de Outono | Śamatha,Jigme Khyentse Rinpoche | Pema Wangyal Rinpoche,,U.B.P.,2016-11-05 a 2016-11-08,"Hotel do Sado, Setúbal, Portugal",Śamatha,Livre (assinantes),,,,';

describe("parseLibraryCsv", () => {
  it("should read multi-line quoted cells and strip the BOM", () => {
    const rows = parseLibraryCsv(csv(SHANTIDEVA, SAMATHA));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      wixId: "w1",
      eventCode: "20191006_12-KPS-ENS-UBP",
      startDate: "2019-10-06",
      endDate: "2019-10-12",
      guestName: "Wulstan Fletcher",
    });
    expect(rows[0]!.raw.mainThemes).toBe("Tema com\nvárias linhas");
  });

  it("should skip rows without a wix id and keep the first of a repeated id", () => {
    const rows = parseLibraryCsv(csv(SAMATHA, SAMATHA.replace("Śamatha", "Other"), ",x,No id,,,,,,,,,,,"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain("Śamatha");
  });

  it("should drop a calendar-invalid date instead of failing the import", () => {
    const rows = parseLibraryCsv(csv(SAMATHA.replace("2016-11-05 a 2016-11-08", "2016-02-30 a 2016-11-08")));
    expect(rows[0]).toMatchObject({ startDate: null, endDate: "2016-11-08" });
  });

  it("should reject a file that is not a library export", () => {
    expect(() => parseLibraryCsv("a,b\n1,2")).toThrow(LibraryCsvError);
  });

  it.skipIf(!existsSync(LATEST))("should parse the latest export (210 rows)", () => {
    const rows = parseLibraryCsv(readFileSync(LATEST, "utf-8"));
    expect(rows).toHaveLength(210);
    const known = rows.find((r) => r.wixId === "01fef61f-d043-4d5e-8115-5c17c70f33ac")!;
    expect(known.eventCode).toBe("20171114_20 - KPS-WFL-ENS-VLH");
    expect(known.teacherNames).toBe("Khenchen Pema Sherab Rinpoche");
    expect(known.guestName).toBe("Wulstan Fletcher");
    expect(known.startDate).toBe("2017-11-14");
    expect(known.endDate).toBe("2017-11-20");
  });

  it.skipIf(!existsSync(SAMPLE))("should stay compatible with the 20250821 export (193 rows)", () => {
    expect(parseLibraryCsv(readFileSync(SAMPLE, "utf-8"))).toHaveLength(193);
  });
});

describe("fold", () => {
  it("should ignore accents, case and the sh/s spelling variant", () => {
    expect(fold("Śāntideva")).toBe(fold("SHANTIDEVA"));
    expect(fold("Palácio  Villa-Helena")).toBe("palacio villa helena");
  });
});

describe("searchRecords", () => {
  const records = parseLibraryCsv(csv(SHANTIDEVA, SAMATHA)).map((r) => ({
    ...r,
    themes: `${r.raw.mainThemes} ${r.raw.sessionThemes}`,
  }));

  it("should find a record from year, name and city, accent-insensitively", () => {
    const hits = searchRecords(records, "2019 shantideva LISBOA");
    expect(hits.map((h) => h.wixId)).toEqual(["w1"]);
  });

  it("should match the teacher and the place", () => {
    expect(searchRecords(records, "khyentse sado")[0]!.wixId).toBe("w2");
  });

  it("should require every token to match", () => {
    expect(searchRecords(records, "2019 sado")).toEqual([]);
  });

  it("should tolerate a typo in a long word", () => {
    expect(searchRecords(records, "samathaa")[0]?.wixId).toBe("w2");
  });

  it("should find a record by the start of its event code", () => {
    expect(searchRecords(records, "20161105")[0]!.wixId).toBe("w2");
  });

  it.skipIf(!existsSync(LATEST))("should search the real export", () => {
    const real = parseLibraryCsv(readFileSync(LATEST, "utf-8")).map((r) => ({
      ...r,
      themes: `${r.raw.mainThemes} ${r.raw.sessionThemes}`,
    }));
    const hits = searchRecords(real, "2019 lisboa khenchen", 3);
    expect(hits[0]!.startDate).toBe("2019-10-06");
  });
});

describe("suggestRecords", () => {
  const records = parseLibraryCsv(csv(SHANTIDEVA, SAMATHA));

  it("should rank an exact event code first, ignoring spacing and punctuation", () => {
    const [top] = suggestRecords(records, { eventCode: "20161105_08 - JKR-PWR-SHA-HSA" });
    expect(top).toMatchObject({ score: 100, record: { wixId: "w2" } });
    expect(top!.reasons).toEqual([{ kind: "code" }]);
  });

  it("should rank an exact wix id first", () => {
    expect(suggestRecords(records, { wixId: "w1" })[0]!.score).toBe(100);
  });

  it("should combine date overlap and teacher name", () => {
    const [top] = suggestRecords(records, {
      startDate: "2019-10-07",
      endDate: "2019-10-09",
      teacherNames: ["khenchen pema sherab rinpoche"],
    });
    expect(top!.record.wixId).toBe("w1");
    expect(top!.reasons.map((r) => r.kind)).toEqual(["date", "teacher"]);
    expect(top!.score).toBeGreaterThanOrEqual(60);
  });

  it("should score a place match from the event's short place name", () => {
    const [top] = suggestRecords(records, { startDate: "2016-11-06", placeName: "Hotel do Sado" });
    expect(top!.record.wixId).toBe("w2");
    expect(top!.reasons.map((r) => r.kind)).toContain("place");
  });

  it("should return nothing for an event unlike any record", () => {
    expect(suggestRecords(records, { startDate: "1999-01-01", title: "Zzz" })).toEqual([]);
  });

  it.skipIf(!existsSync(LATEST))("should pre-select the real record for its own dates and teacher", () => {
    const real = parseLibraryCsv(readFileSync(LATEST, "utf-8"));
    const [top] = suggestRecords(real, {
      startDate: "2017-11-14",
      endDate: "2017-11-20",
      teacherNames: ["Khenchen Pema Sherab Rinpoche"],
      title: "O Nono Capítulo da Via do Bodhisattva",
    });
    expect(top!.record.wixId).toBe("01fef61f-d043-4d5e-8115-5c17c70f33ac");
    expect(top!.score).toBeGreaterThanOrEqual(80);
  });
});

describe("detectLanguage", () => {
  it("should tell English from Portuguese and fall back on ties", () => {
    expect(detectLanguage("Day 1 | Morning Sessions of the teachings", "pt")).toBe("en");
    expect(detectLanguage("Ensinamentos sobre a natureza da mente", "en")).toBe("pt");
    expect(detectLanguage("Śāntideva", "en")).toBe("en");
    expect(detectLanguage("Day 1 | Summary: a root cause of the self", "pt")).toBe("en");
    expect(detectLanguage("", "pt")).toBe("pt");
  });
});

describe("mapRecordToEvent", () => {
  const ref: MappingRef = {
    teachers: [{ id: 1, name: "Khenchen Pema Sherab Rinpoche", abbreviation: "KPS", aliases: [] }],
    places: [{ id: 5, name: "UBP", abbreviation: "UBP", location: "UBP, Av. 5 de Outubro, Lisboa, Portugal" }],
    eventTypes: [{ id: 2, nameEn: "Teaching", namePt: "Ensinamento" }],
    groups: [{ id: 9, nameEn: "Śamatha", namePt: "Śamatha" }],
    audiences: [{ id: 3, nameEn: "Event participants", namePt: "Participantes no evento" }],
  };
  const [shantideva, samatha] = parseLibraryCsv(csv(SHANTIDEVA, SAMATHA));

  it("should resolve ids and map the text fields without creating anything", () => {
    const m = mapRecordToEvent(shantideva!, ref);
    expect(m.fields).toMatchObject({
      titlePt: "O Nono Capítulo, Parte 3",
      startDate: "2019-10-06",
      endDate: "2019-10-12",
      eventTypeId: 2,
      audienceId: 3,
      groupIds: [],
      placeIds: [5],
      teacherIds: [{ id: 1, role: "teacher" }],
      organizer: "F. Kangyur Rinpoche, Songtsen",
      wixId: "w1",
    });
    expect(m.fields.mainThemesPt).toBe("Tema com\nvárias linhas");
    // The session summaries are English in the export, so they land in the EN field.
    expect(m.fields.sessionThemesEn).toBe("Śāntideva | Day 1");
    expect(m.fields.sessionThemesPt).toBeNull();
    expect(m.fields.bibliography).toBe("Bibliografia");
  });

  it("should list a guest that does not exist yet as unresolved with role guest", () => {
    const m = mapRecordToEvent(shantideva!, ref);
    expect(m.unresolved.teachers).toEqual([{ name: "Wulstan Fletcher", role: "guest" }]);
  });

  it("should map a group designation to a retreat group, not an event type", () => {
    const m = mapRecordToEvent(samatha!, ref);
    expect(m.fields.eventTypeId).toBeNull();
    expect(m.fields.groupIds).toEqual([9]);
    expect(m.unresolved.audience).toBe("Livre (assinantes)");
    expect(m.unresolved.places).toEqual(["Hotel do Sado, Setúbal, Portugal"]);
  });

  it("should keep fields without a column in the snapshot", () => {
    const m = mapRecordToEvent(shantideva!, ref, new Date("2026-01-01T00:00:00Z"));
    expect(m.fields.librarySnapshot).toMatchObject({
      source: "library-csv",
      designation: "Ensinamento",
      organizations: ["F. Kangyur Rinpoche", "Songtsen"],
      notes: "Completo e Revisto",
      importedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
