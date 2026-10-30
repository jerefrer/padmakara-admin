import { lineText, type Slide } from "../../../src/lib/slides/types.ts";

/** An event row shaped like the query in src/services/slide-metadata.ts returns it,
 *  filled with the example the designer sent: Jigme Khyentse Rinpoche, October 2026. */
export const ANDRE_EVENT = {
  id: 7,
  titleEn: "Learning to let go and enjoying space",
  titlePt: "Aprender a largar e a apreciar o espaço",
  originalLanguage: "en",
  startDate: "2026-10-10",
  eventOrganizers: [{ position: 0, organizer: { id: 1, name: "Fundação Kangyur Rinpoche", abbreviation: null } }],
  creditLines: [],
  copyrightHolder: "Padmakara Portugal",
  eventTeachers: [{ teacher: { name: "Jigme Khyentse Rinpoche" } }],
  eventPlaces: [{ place: { name: "Lisbon", location: "Portugal" } }],
  sessions: [
    { sessionNumber: 1, sessionDate: "2026-10-10", timePeriod: "morning" },
    { sessionNumber: 2, sessionDate: "2026-10-11", timePeriod: "morning" },
    { sessionNumber: 3, sessionDate: "2026-10-12", timePeriod: "morning" },
    { sessionNumber: 4, sessionDate: "2026-10-13", timePeriod: "morning" },
  ],
};

/** An event with nothing but a title; every other input is missing. */
export const EMPTY_EVENT = {
  id: 7,
  titleEn: "Retreat",
  titlePt: null,
  originalLanguage: "en",
  startDate: null,
  eventOrganizers: [],
  creditLines: [],
  copyrightHolder: null,
  eventTeachers: [],
  eventPlaces: [],
  sessions: [],
};

/** The text of each line of a slide; images and spacers read as "". */
export function slideLines(slide: Slide): string[] {
  return slide.lines.map(lineText);
}
