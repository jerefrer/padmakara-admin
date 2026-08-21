/**
 * Render tests for the AI assistant's review table.
 *
 * `aiAssistDiff.test.ts` pins down which rows exist; this pins down that they
 * reach the screen as a table the admin can act on — a track's number in its
 * own cell, current and proposed in aligned columns, the words that moved
 * picked out, and a checkbox per row deciding what Apply actually writes. The
 * diff model can be perfectly right and still be useless if the table that
 * consumes it regresses.
 *
 * Mounted with react-dom directly: this project has no @testing-library.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// react-admin pulls a whole provider tree we don't need here; the panel only
// takes a translate function and a notifier from it.
vi.mock("react-admin", () => ({
  useTranslate: () => (key: string, options?: Record<string, unknown>) => {
    const short = key.replace(/^padmakara\./, "");
    if (options && "number" in options) return `${short}:${String(options.number)}`;
    return short;
  },
  useNotify: () => () => {},
}));

import { AiAssistPanel, type AiAssistResult, type AiAssistTrack } from "./AiAssistPanel";

let container: HTMLDivElement;
let root: Root;
let applied: AiAssistResult | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  applied = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const makeTrack = (over: Partial<AiAssistTrack> & Pick<AiAssistTrack, "rowKey">): AiAssistTrack => ({
  sessionNumber: 1, trackNumber: 1,
  originalFilename: "001.mp3", title: "Untitled",
  titleEn: "", titlePt: "", speaker: "", languages: ["en"],
  ...over,
});

/** Two tracks in different sessions, each getting a Portuguese title. */
const TWO_SESSIONS: AiAssistTrack[] = [
  makeTrack({ rowKey: "t1", sessionNumber: 1, trackNumber: 2, title: "Morning teaching", titleEn: "Morning teaching" }),
  makeTrack({ rowKey: "t2", sessionNumber: 2, trackNumber: 7, title: "Evening teaching", titleEn: "Evening teaching" }),
];
const TWO_SESSIONS_RESULT: AiAssistResult = {
  sessions: [], videos: [],
  tracks: [
    { rowKey: "t2", titlePt: "Ensinamento da noite" },
    { rowKey: "t1", titlePt: "Ensinamento da manhã" },
  ],
};

/**
 * Mount the panel and drive one round-trip, with `fetch` stubbed so the reply
 * is `result` without touching the network.
 */
async function ask(tracks: AiAssistTrack[], result: AiAssistResult): Promise<void> {
  vi.stubGlobal("fetch", vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(result), {
      status: 200, headers: { "Content-Type": "application/json" },
    })),
  ));
  localStorage.setItem("accessToken", "test-token");

  await act(async () => {
    root.render(
      <AiAssistPanel
        endpoint="/api/admin/events/1/rename-tracks"
        event={{ titleEn: "Spring retreat" }}
        sessions={[]}
        tracks={tracks}
        onApply={(r) => { applied = r; }}
      />,
    );
  });

  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("instruction field not found");
  await act(async () => {
    // React tracks the value on the DOM node, so set it through the native
    // setter or the synthetic change event is dropped as a no-op.
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value",
    )?.set;
    setValue?.call(textarea, "translate the titles to Portuguese");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await act(async () => button("aiAssist.ask").click());
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`button "${label}" not found`);
  return found;
}

const bodyRows = () => [...container.querySelectorAll("tbody tr")];
const cellsOf = (row: Element): string[] =>
  [...row.querySelectorAll("td")].map((c) => c.textContent?.trim() ?? "");
/** A track row carries values; a session heading is just checkbox + label. */
const isValueRow = (row: Element) => row.querySelectorAll("td").length > 2;
const checkboxIn = (row: Element) =>
  row.querySelector("input[type=checkbox]") as HTMLInputElement;

describe("AiAssistPanel review table", () => {
  it("shows each proposed change as a row of aligned cells, keyed by track number", async () => {
    await ask(TWO_SESSIONS, TWO_SESSIONS_RESULT);

    expect([...container.querySelectorAll("th")].map((h) => h.textContent)).toEqual([
      // The leading cell is the section's select-all checkbox.
      "", "aiAssist.colTrack", "aiAssist.colField", "aiAssist.colCurrent", "aiAssist.colProposed",
    ]);

    // Rows come back in session/track order regardless of the reply's order.
    expect(bodyRows().map(cellsOf)).toEqual([
      ["", "session.session:1"],
      ["", "02Morning teaching", "PT", "—", "Ensinamento da manhã"],
      ["", "session.session:2"],
      ["", "07Evening teaching", "PT", "—", "Ensinamento da noite"],
    ]);
  });

  it("keeps a track's number and title on one line", async () => {
    await ask(
      [makeTrack({ rowKey: "t1", trackNumber: 6, title: "Elements and dissolution" })],
      { sessions: [], videos: [], tracks: [{ rowKey: "t1", titleEn: "Elements & dissolution" }] },
    );

    const itemCell = [...bodyRows().find(isValueRow)!.querySelectorAll("td")][1]!;
    // Number and title share one flex parent; stacking them put the title on
    // a second line and left the column needlessly narrow.
    expect(itemCell.children).toHaveLength(1);
    const line = itemCell.children[0] as HTMLElement;
    expect(getComputedStyle(line).display).toBe("flex");
    expect([...line.children].map((el) => el.textContent)).toEqual([
      "06", "Elements and dissolution",
    ]);
  });

  it("gives a session heading more height than the rows it introduces", async () => {
    await ask(TWO_SESSIONS, TWO_SESSIONS_RESULT);

    const padding = (row: Element) =>
      parseFloat(getComputedStyle(row.querySelectorAll("td")[1]!).paddingTop);
    const heading = bodyRows().find((r) => !isValueRow(r))!;
    const value = bodyRows().find(isValueRow)!;

    // The heading opens a session — it read as a thinner divider before.
    expect(padding(heading)).toBeGreaterThan(padding(value));
  });

  it("leaves current and proposed the same width", async () => {
    await ask(TWO_SESSIONS, TWO_SESSIONS_RESULT);

    const headers = [...container.querySelectorAll("th")];
    const width = (th: Element) => getComputedStyle(th).width;

    // Under a fixed table layout, equal size comes from declaring no width on
    // either — pinning current to a percentage starved proposed of the rest.
    expect(width(headers[3]!)).toBe(width(headers[4]!));
    expect(width(headers[3]!)).not.toMatch(/%|px/);
  });

  it("splits a value so the words that moved are their own elements", async () => {
    await ask(
      [makeTrack({ rowKey: "t1", trackNumber: 4, titleEn: "Morning teaching part 1" })],
      { sessions: [], videos: [], tracks: [{ rowKey: "t1", titleEn: "Morning teaching, part one" }] },
    );

    const row = bodyRows().find(isValueRow)!;
    const cells = [...row.querySelectorAll("td")];
    const spansOf = (cell: Element) => [...cell.querySelectorAll("span")].map((el) => el.textContent);

    // "Morning " and " part " are shared, so they stay in their own untouched
    // runs on both sides — only the differing words are separated out.
    expect(spansOf(cells[3]!)).toEqual(["Morning ", "teaching", " part ", "1"]);
    expect(spansOf(cells[4]!)).toEqual(["Morning ", "teaching,", " part ", "one"]);
  });
});

describe("AiAssistPanel selection", () => {
  it("counts the changes it is showing", async () => {
    await ask(TWO_SESSIONS, TWO_SESSIONS_RESULT);
    expect(container.textContent).toContain("aiAssist.changeCount");
  });

  it("applies only the rows left ticked", async () => {
    await ask(TWO_SESSIONS, TWO_SESSIONS_RESULT);

    const rows = bodyRows().filter(isValueRow);
    expect(rows).toHaveLength(2);
    await act(async () => checkboxIn(rows[0]!).click());
    await act(async () => button("aiAssist.apply").click());

    // The unticked track drops out; the other is applied untouched.
    expect(applied).toEqual({
      event: undefined, sessions: [], videos: [],
      tracks: [{ rowKey: "t2", titlePt: "Ensinamento da noite" }],
    });
  });

  it("clears a whole session from one heading checkbox", async () => {
    await ask(TWO_SESSIONS, TWO_SESSIONS_RESULT);

    const heading = bodyRows().find((r) => !isValueRow(r))!;
    await act(async () => checkboxIn(heading).click());
    await act(async () => button("aiAssist.apply").click());

    expect(applied?.tracks.map((tr) => tr.rowKey)).toEqual(["t2"]);
  });

  it("will not apply anything once every row is unticked", async () => {
    await ask(TWO_SESSIONS, TWO_SESSIONS_RESULT);

    const selectAll = container.querySelector("thead input[type=checkbox]") as HTMLInputElement;
    await act(async () => selectAll.click());

    expect(button("aiAssist.apply").disabled).toBe(true);
    expect(container.textContent).toContain("aiAssist.changeCountSelected");
  });
});

describe("AiAssistPanel request", () => {
  it("sends the admin's session and track numbers so positional instructions work", async () => {
    await ask(TWO_SESSIONS, TWO_SESSIONS_RESULT);

    const [, init] = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]!;
    const sent = JSON.parse(String(init.body));

    expect(sent.tracks).toMatchObject([
      { rowKey: "t1", sessionNumber: 1, trackNumber: 2 },
      { rowKey: "t2", sessionNumber: 2, trackNumber: 7 },
    ]);
  });
});
