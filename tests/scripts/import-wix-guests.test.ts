import { describe, it, expect } from "vitest";
import {
  parseWixGuestRows,
  matchTeacherName,
  matchEvent,
  planRow,
  formatReport,
  formatNameMatches,
  type CandidateEvent,
} from "../../src/scripts/import-wix-guests.ts";
import type { RefTeacher } from "../../src/services/library-records.ts";

const HEADER = "ID,eventCode,teacherName,guestName,Aux-introGuest";
const csv = (...rows: string[]) => "﻿" + [HEADER, ...rows].join("\n");

const LEMBRUN = 'w1,20221101_03-SRR-JKR-PWR-TRR-PP3-CCA,Jigme Khyentse Rinpoche | Pema Wangyal Rinpoche,Shechen Rabjam Rinpoche,com a presença de';
const PRACTICE = "w2,20191104-JKR-PWR-TRR-PBS-HSA,Jigme Khyentse Rinpoche | Pema Wangyal Rinpoche,Rangdrol Rinpoche,sessões de prática por";
const NO_GUEST = "w3,20160101-JKR-ENS-HSA,Jigme Khyentse Rinpoche,,";

const teachers: RefTeacher[] = [
  { id: 1, name: "Jigme Khyentse Rinpoche", abbreviation: "JKR", aliases: [] },
  { id: 2, name: "Pema Wangyal Rinpoche", abbreviation: "PWR", aliases: ["TPWR"] },
  { id: 3, name: "Shechen Rabjam Rinpoche", abbreviation: "SRR", aliases: [] },
  { id: 4, name: "Rangdrol Rinpoche", abbreviation: "RR", aliases: [] },
  { id: 5, name: "Kyabje Trulshik Rinpoche", abbreviation: "KTR", aliases: [] },
  { id: 6, name: "Khenchen Pema Sherab Rinpoche", abbreviation: "KPS", aliases: [] },
];

const link = (teacherId: number, role: string, position: number) => ({
  teacherId,
  role,
  position,
  teacher: { name: teachers.find((t) => t.id === teacherId)!.name },
});

const event = (over: Partial<CandidateEvent> = {}): CandidateEvent => ({
  id: 10,
  eventCode: "20221101_03-SRR-JKR-PWR-TRR-PP3-CCA",
  wixId: null,
  guestIntro: null,
  eventTeachers: [link(3, "teacher", 0), link(1, "teacher", 1), link(2, "teacher", 2)],
  ...over,
});

describe("parseWixGuestRows", () => {
  it("should keep only the rows that name a guest or an intro and split the names on ' | '", () => {
    const rows = parseWixGuestRows(csv(LEMBRUN, NO_GUEST));

    expect(rows).toEqual([
      {
        wixId: "w1",
        eventCode: "20221101_03-SRR-JKR-PWR-TRR-PP3-CCA",
        mainNames: ["Jigme Khyentse Rinpoche", "Pema Wangyal Rinpoche"],
        guestNames: ["Shechen Rabjam Rinpoche"],
        introRaw: "com a presença de",
        intro: "with_presence_of",
      },
    ]);
  });

  it("should not split a name that holds a comma", () => {
    const [row] = parseWixGuestRows(csv('w9,C,"42º Sakya Trizin, Ratna Vajra Rinpoche",Pema Wangyal Rinpoche,&'));

    expect(row!.mainNames).toEqual(["42º Sakya Trizin, Ratna Vajra Rinpoche"]);
    expect(row!.intro).toBe("and");
  });

  it("should mark an unknown phrase as undefined rather than guessing", () => {
    const [row] = parseWixGuestRows(csv("w9,C,Jigme Khyentse Rinpoche,Rangdrol Rinpoche,com amigos"));

    expect(row!.intro).toBeUndefined();
  });
});

describe("matchTeacherName", () => {
  it("should match by name ignoring accents and case, and by alias", () => {
    expect(matchTeacherName("jigme khyentse rinpoché", teachers)).toMatchObject({ kind: "exact", teacher: { id: 1 } });
    expect(matchTeacherName("TPWR", teachers)).toMatchObject({ kind: "exact", teacher: { id: 2 } });
  });

  it("should match a shortened name when only one teacher fits", () => {
    expect(matchTeacherName("Rabjam Rinpoche", teachers)).toMatchObject({ kind: "partial", teacher: { id: 3 } });
    expect(matchTeacherName("K. Trulshik Rinpoche", teachers)).toMatchObject({ kind: "partial", teacher: { id: 5 } });
  });

  it("should report an ambiguous partial name instead of picking one", () => {
    expect(matchTeacherName("Pema Rinpoche", teachers).kind).toBe("ambiguous");
  });

  it("should not match on generic words alone or on an unknown name", () => {
    expect(matchTeacherName("Rinpoche", teachers).kind).toBe("none");
    expect(matchTeacherName("41º Sakya Trichen", teachers).kind).toBe("none");
  });
});

describe("matchEvent", () => {
  it("should prefer the Wix ID, then the punctuation-insensitive event code", () => {
    const a = event({ id: 1, wixId: "w1", eventCode: "OTHER" });
    const b = event({ id: 2, eventCode: "20221101 03 SRR JKR PWR TRR PP3 CCA" });

    expect(matchEvent({ wixId: "w1", eventCode: b.eventCode }, [a, b])).toMatchObject({ event: { id: 1 }, by: "wixId" });
    expect(matchEvent({ wixId: "nope", eventCode: "20221101_03-SRR-JKR-PWR-TRR-PP3-CCA" }, [a, b])).toMatchObject({
      event: { id: 2 },
      by: "code",
    });
  });
});

describe("planRow", () => {
  const [lembrun] = parseWixGuestRows(csv(LEMBRUN));

  it("should propose the Wix main teachers in order, then the guests, with the intro key", () => {
    const plan = planRow(lembrun!, [event()], teachers);

    expect(plan.status).toBe("change");
    if (plan.status !== "change") return;
    expect(plan.proposed.guestIntro).toBe("with_presence_of");
    expect(plan.proposed.links.map((l) => [l.teacherId, l.role])).toEqual([
      [1, "teacher"],
      [2, "teacher"],
      [3, "guest"],
    ]);
  });

  it("should keep a teacher the event has that Wix does not list", () => {
    const plan = planRow(lembrun!, [event({ eventTeachers: [link(4, "teacher", 0)] })], teachers);

    if (plan.status !== "change") throw new Error(plan.status);
    expect(plan.proposed.links).toContainEqual({ teacherId: 4, name: "Rangdrol Rinpoche", role: "teacher", note: "kept" });
  });

  it("should say unchanged when the event already matches", () => {
    const done = event({
      guestIntro: "with_presence_of",
      eventTeachers: [link(1, "teacher", 0), link(2, "teacher", 1), link(3, "guest", 2)],
    });

    expect(planRow(lembrun!, [done], teachers).status).toBe("unchanged");
  });

  it("should skip the event and list the names it cannot match", () => {
    const [row] = parseWixGuestRows(csv("w5,20221101_03-SRR-JKR-PWR-TRR-PP3-CCA,41º Sakya Trichen,Pema Wangyal Rinpoche,&"));

    const plan = planRow(row!, [event()], teachers);

    expect(plan).toMatchObject({ status: "unmatched", problems: ['no teacher named "41º Sakya Trichen"'] });
  });

  it("should report a row with no event", () => {
    expect(planRow(lembrun!, [], teachers).status).toBe("no-event");
  });
});

describe("formatNameMatches", () => {
  it("should list each distinct name once with how it matched", () => {
    const rows = parseWixGuestRows(csv(LEMBRUN, "w7,C,Jigme Khyentse Rinpoche,Rabjam Rinpoche | Lama Nobody,&"));

    expect(formatNameMatches(rows, teachers).split("\n")).toEqual([
      "  =  Jigme Khyentse Rinpoche",
      "  ✗  Lama Nobody (no teacher)",
      "  =  Pema Wangyal Rinpoche",
      "  ~  Rabjam Rinpoche → Shechen Rabjam Rinpoche",
      "  =  Shechen Rabjam Rinpoche",
    ]);
  });
});

describe("formatReport", () => {
  it("should print the event code, the current and the proposed state, and the totals", () => {
    const rows = parseWixGuestRows(csv(LEMBRUN, PRACTICE));
    const plans = rows.map((r) => planRow(r, [event()], teachers));

    const report = formatReport(plans, 1);

    expect(report).toContain("CHANGE  #10 20221101_03-SRR-JKR-PWR-TRR-PP3-CCA");
    expect(report).toContain(
      "  now:  main: Shechen Rabjam Rinpoche | Jigme Khyentse Rinpoche | Pema Wangyal Rinpoche / intro: default / guests: -",
    );
    expect(report).toContain(
      '  new:  main: Jigme Khyentse Rinpoche | Pema Wangyal Rinpoche / intro: with_presence_of ("with the presence of") / guests: Shechen Rabjam Rinpoche',
    );
    expect(report).toContain("NOEVENT 20191104-JKR-PWR-TRR-PBS-HSA [w2]");
    expect(report).toContain("change 1, unchanged 0, skipped for unmatched names/phrase 0, no event 1.");
  });
});
