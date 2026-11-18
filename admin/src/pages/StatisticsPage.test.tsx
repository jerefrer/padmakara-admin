// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => mockNavigate }));
vi.mock("react-admin", () => ({
  Title: () => null,
  useLocaleState: () => ["en", () => {}],
  useTranslate: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key} ${JSON.stringify(opts)}` : key,
}));
const mockFetch = vi.fn();
vi.mock("../utils/authFetch", () => ({ authFetch: (...a: unknown[]) => mockFetch(...a) }));

import { StatisticsPage } from "./StatisticsPage";
import { rangeFor } from "../utils/statisticsRange";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const month = (m: string, signups: number) => ({
  month: m,
  signups,
  activeUsers: signups * 2,
  teachingSalesCents: 1500,
  membershipCents: 2500,
  readAlongOpens: signups * 3,
});

const RESPONSE = {
  range: { from: "2026-10-15", to: "2026-11-13" },
  accounts: { total: 321, newInRange: 17, activeMembers: 42 },
  activeUsers: { last7: 11, last30: 29, inRange: 29 },
  monthly: [month("2026-10", 3), month("2026-11", 5)],
  platforms: [
    { deviceType: "ios", count: 50 },
    { deviceType: "android", count: 20 },
    { deviceType: "web", count: 5 },
  ],
  appOpens: [],
  events: [
    { id: 1, title: "Alpha", titlePt: null, startDate: "2026-04-10", endDate: "2026-04-12", listeners: 5, completedTracks: 1, listenHours: 2, videoViewers: 0, transcriptOpens: 9, readAlongOpens: 4, fileOpens: 0, videoStarts: 0, zipDownloads: 0, videoDownloads: 0 },
    { id: 2, title: "Beta Ngöndro", titlePt: null, startDate: "2025-10-03", endDate: "2025-10-05", listeners: 8, completedTracks: 4, listenHours: 1, videoViewers: 3, transcriptOpens: 1, readAlongOpens: 2, fileOpens: 3, videoStarts: 7, zipDownloads: 2, videoDownloads: 1 },
  ],
};

const DETAIL = {
  range: { from: "2026-10-20", to: "2026-11-18" },
  itemsRecordedFrom: "2026-11-19",
  event: { id: 2, title: "Beta Ngöndro", titlePt: null, startDate: "2025-10-03", endDate: "2025-10-05" },
  tracks: [
    { id: 31, title: "Introduction", trackNumber: 1, sessionNumber: 1, sessionTitle: "Morning", listeners: 4, completions: 2, listenHours: 1.5 },
  ],
  videos: [
    { id: 70, title: "Day 1", titlePt: null, position: 0, viewers: 3, plays: 9 },
    { id: 71, title: null, titlePt: null, position: 1, viewers: 0, plays: 0 },
  ],
  documents: [
    { id: 50, title: "Prayer sheet", filename: "prayer.pdf", opens: 6 },
    { id: 51, title: null, filename: "photo.jpg", opens: 0 },
  ],
  transcripts: [{ id: 90, language: "en", filename: "beta-en.pdf", opens: 2 }],
};

let container: HTMLDivElement;
let root: Root;
let detail: unknown;

const text = () => container.textContent ?? "";
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const rowTitles = () =>
  Array.from(container.querySelectorAll('[data-testid="event-title"]')).map((r) => r.textContent);
const rowCells = (index: number) =>
  Array.from(container.querySelectorAll('[data-testid="event-row"]')[index]!.querySelectorAll("td")).map((c) => c.textContent);
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const search = (value: string) =>
  act(() => {
    const input = container.querySelector<HTMLInputElement>('[data-testid="teaching-search"]')!;
    // React tracks the input's value through the native setter, so set it there before the input event
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const drawer = () => document.querySelector('[data-testid="teaching-drawer"]');
const openDrawerFor = async (index: number) => {
  click(container.querySelectorAll('[data-testid="event-row"]')[index]!);
  await flush();
};

beforeEach(async () => {
  detail = DETAIL;
  mockFetch.mockReset().mockImplementation(async (url: string) =>
    url.includes("/statistics/events/")
      ? { ok: true, json: async () => detail }
      : { ok: true, json: async () => RESPONSE },
  );
  mockNavigate.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<StatisticsPage />));
  await flush();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("StatisticsPage", () => {
  it("should show the account and activity tiles from the response", () => {
    expect(text()).toContain("321");
    expect(text()).toContain("17");
    expect(text()).toContain("42");
    expect(text()).toContain("11");
    expect(text()).toContain("29");
  });

  it("should list the events by listeners, most first, by default", () => {
    expect(rowTitles()).toEqual(["Beta Ngöndro", "Alpha"]);
    expect(text()).toContain("padmakara.statistics.privacyNote");
  });

  it("should show each teaching's dates under its title", () => {
    const dates = Array.from(container.querySelectorAll('[data-testid="event-dates"]')).map((d) => d.textContent);
    expect(dates).toEqual(["03–05/10/2025", "10–12/04/2026"]);
  });

  it("should group the columns under Audio, Video and Texts", () => {
    const groups = Array.from(container.querySelectorAll("thead tr:first-child th")).map((c) => c.textContent);
    expect(groups).toEqual([
      "padmakara.statistics.teaching",
      "padmakara.statistics.group_audio",
      "padmakara.statistics.group_video",
      "padmakara.statistics.group_texts",
      "padmakara.statistics.col_downloads",
    ]);
    const columns = Array.from(container.querySelectorAll("thead tr:nth-child(2) th")).map((c) => c.textContent);
    expect(columns).toEqual([
      "padmakara.statistics.col_listeners",
      "padmakara.statistics.col_completedTracks",
      "padmakara.statistics.col_listenHours",
      "padmakara.statistics.col_videoViewers",
      "padmakara.statistics.col_videoStarts",
      "padmakara.statistics.col_transcriptOpens",
      "padmakara.statistics.col_readAlongOpens",
      "padmakara.statistics.col_fileOpens",
    ]);
  });

  it("should explain what every column counts", () => {
    for (const key of ["listeners", "completedTracks", "listenHours", "videoViewers", "videoStarts", "transcriptOpens", "readAlongOpens", "fileOpens", "downloads"]) {
      const label = container.querySelector(`[data-testid="help-${key}"]`);
      expect(label?.getAttribute("aria-label")).toBe(`padmakara.statistics.help_${key}`);
    }
  });

  it("should show zeros muted and other counts in the normal colour", () => {
    // Alpha: video viewers 0, listeners 5
    const alpha = container.querySelectorAll('[data-testid="event-row"]')[1]!;
    const figures = Array.from(alpha.querySelectorAll("td:not(:first-child) > span"));
    const viewers = figures[3]!;
    const listeners = figures[0]!;
    expect(viewers.textContent).toBe("0");
    expect(viewers.getAttribute("data-zero")).toBe("true");
    expect(listeners.getAttribute("data-zero")).toBeNull();
  });

  it("should show hours with one decimal and thousands with separators", async () => {
    const big = { ...RESPONSE.events[0]!, id: 9, title: "Gamma", listeners: 99, listenHours: 1230.4, transcriptOpens: 1234 };
    mockFetch.mockImplementation(async () => ({ ok: true, json: async () => ({ ...RESPONSE, events: [big] }) }));
    click(container.querySelector('[data-testid="range-90"]')!);
    await flush();
    const cells = rowCells(0);
    expect(cells[3]).toBe("1,230.4");
    expect(cells[6]).toBe("1,234");
  });

  it("should show the platforms with friendly names and counts", () => {
    expect(text()).toContain("iPhone");
    expect(text()).toContain("Android");
    expect(text()).toContain("Web");
    expect(text()).toContain("50");
  });

  it("should give every monthly chart its own card titled with its name and the period", () => {
    const grid = container.querySelector('[data-testid="chart-grid"]')!;
    const cards = Array.from(grid.children);
    expect(cards).toHaveLength(4);
    const titles = cards.map((c) => c.querySelector("h6, .MuiTypography-subtitle1")?.textContent);
    expect(titles).toEqual([
      "padmakara.statistics.signups, padmakara.statistics.last12",
      "padmakara.statistics.activeUsersMonthly, padmakara.statistics.last12",
      "padmakara.statistics.teachingSales, padmakara.statistics.last12",
      "padmakara.statistics.membershipIncome, padmakara.statistics.last12",
    ]);
  });

  it("should add a total row of the additive columns at the bottom, whatever the sort", () => {
    const check = () => {
      const rows = Array.from(container.querySelectorAll("tbody tr"));
      expect(rows[rows.length - 1]!.getAttribute("data-testid")).toBe("total-row");
      const cells = Array.from(rows[rows.length - 1]!.querySelectorAll("td")).map((c) => c.textContent);
      // teaching | listeners, completed, hours | viewers, plays | transcripts, read-along, documents | downloads
      expect(cells).toEqual([
        'padmakara.statistics.totalOf {"smart_count":2}', "", "5", "3.0", "", "7", "10", "6", "3", "3",
      ]);
    };
    check();
    click(container.querySelector('[data-testid="sort-listeners"]')!);
    check();
  });

  it("should filter the teachings by title, ignoring case and accents, and total only those shown", () => {
    search("ngondro");
    expect(rowTitles()).toEqual(["Beta Ngöndro"]);
    const total = container.querySelector('[data-testid="total-row"]')!;
    expect(total.textContent).toContain('{"smart_count":1}');
    // Beta's completed tracks alone
    expect(Array.from(total.querySelectorAll("td")).map((c) => c.textContent)[2]).toBe("4");
  });

  it("should say so when no teaching matches the search", () => {
    search("zzz");
    expect(rowTitles()).toEqual([]);
    expect(text()).toContain('padmakara.statistics.noMatch {"query":"zzz"}');
    expect(container.querySelector('[data-testid="total-row"]')).toBeNull();
  });

  it("should sort by title alphabetically, A to Z first", () => {
    click(container.querySelector('[data-testid="sort-title"]')!);
    expect(rowTitles()).toEqual(["Alpha", "Beta Ngöndro"]);
    click(container.querySelector('[data-testid="sort-title"]')!);
    expect(rowTitles()).toEqual(["Beta Ngöndro", "Alpha"]);
  });

  it("should put the 12-month charts before the period selector and the period-dependent blocks after it", () => {
    const html = container.innerHTML;
    const at = (needle: string) => html.indexOf(needle);
    expect(at("padmakara.statistics.last12Heading")).toBeLessThan(at('data-testid="chart-grid"'));
    expect(at('data-testid="chart-grid"')).toBeLessThan(at('data-testid="range-7"'));
    expect(at('data-testid="range-7"')).toBeLessThan(at("padmakara.statistics.newAccounts"));
    expect(at("padmakara.statistics.newAccounts")).toBeLessThan(at("padmakara.statistics.platforms"));
    expect(at("padmakara.statistics.active30")).toBeLessThan(at('data-testid="range-7"'));
  });

  it("should show monthly income in euros", () => {
    expect(text()).toContain("€15");
    expect(text()).toContain("€25");
  });

  it("should flip the sort of the active column, then sort a new column descending first", () => {
    click(container.querySelector('[data-testid="sort-listeners"]')!);
    expect(rowTitles()).toEqual(["Alpha", "Beta Ngöndro"]);
    click(container.querySelector('[data-testid="sort-listeners"]')!);
    expect(rowTitles()).toEqual(["Beta Ngöndro", "Alpha"]);
  });

  it("should sort the events table by read-along opens", () => {
    click(container.querySelector('[data-testid="sort-readAlongOpens"]')!);
    expect(rowTitles()).toEqual(["Alpha", "Beta Ngöndro"]);
  });

  it("should sort the events table by documents opened", () => {
    click(container.querySelector('[data-testid="sort-transcriptOpens"]')!);
    expect(rowTitles()).toEqual(["Alpha", "Beta Ngöndro"]);
    click(container.querySelector('[data-testid="sort-fileOpens"]')!);
    expect(rowTitles()).toEqual(["Beta Ngöndro", "Alpha"]);
  });

  it("should keep video plays, documents opened and downloads in separate columns", () => {
    // Beta: plays 7 | transcripts 1, read-along 2, documents 3 | downloads 2 ZIPs + 1 video = 3
    expect(rowCells(0).slice(-5)).toEqual(["7", "1", "2", "3", "3"]);
  });

  it("should open the teaching's detail when a row is clicked, for the selected period", async () => {
    expect(drawer()).toBeNull();
    await openDrawerFor(0);
    expect(drawer()).not.toBeNull();
    const { from, to } = rangeFor(30);
    expect(mockFetch).toHaveBeenLastCalledWith(`/api/admin/statistics/events/2?from=${from}&to=${to}`);
  });

  it("should open the detail from the keyboard", async () => {
    const row = container.querySelectorAll('[data-testid="event-row"]')[0]!;
    act(() => { row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
    expect(drawer()).not.toBeNull();
  });

  it("should list each document with its opens in the detail", async () => {
    await openDrawerFor(0);
    const rows = Array.from(drawer()!.querySelectorAll('[data-testid="detail-documents-row"]')).map((r) =>
      Array.from(r.querySelectorAll("td")).map((c) => c.textContent),
    );
    expect(rows).toEqual([
      ["Prayer sheetprayer.pdf", "6"],
      ["photo.jpg", "0"],
    ]);
  });

  it("should list videos with viewers and plays, transcripts and listened tracks in the detail", async () => {
    await openDrawerFor(0);
    const cells = (id: string) =>
      Array.from(drawer()!.querySelectorAll(`[data-testid="${id}-row"]`)).map((r) =>
        Array.from(r.querySelectorAll("td")).map((c) => c.textContent),
      );
    expect(cells("detail-videos")).toEqual([
      ["Day 1", "3", "9"],
      ['padmakara.statistics.videoPart {"n":2}', "0", "0"],
    ]);
    expect(cells("detail-transcripts")).toEqual([["beta-en.pdfpadmakara.statistics.language_en", "2"]]);
    expect(cells("detail-tracks")).toEqual([
      ['Introductionpadmakara.statistics.sessionNumber {"n":1} · Morning', "4", "2", "1.5"],
    ]);
  });

  it("should say from when per-item counts exist when the period starts earlier", async () => {
    await openDrawerFor(0);
    const note = drawer()!.querySelector('[data-testid="items-note"]');
    expect(note?.textContent).toBe('padmakara.statistics.itemsFrom {"date":"19 Nov 2026"}');
  });

  it("should not warn when per-item counts cover the whole period", async () => {
    detail = { ...DETAIL, itemsRecordedFrom: "2026-10-01" };
    await openDrawerFor(0);
    expect(drawer()!.querySelector('[data-testid="items-note"]')).toBeNull();
  });

  it("should say per-item counts start now when none was recorded yet", async () => {
    detail = { ...DETAIL, itemsRecordedFrom: null };
    await openDrawerFor(0);
    expect(drawer()!.querySelector('[data-testid="items-note"]')?.textContent).toBe("padmakara.statistics.itemsNone");
  });

  it("should show an error in the detail when it cannot be loaded", async () => {
    mockFetch.mockImplementation(async () => ({ ok: false, status: 500 }));
    await openDrawerFor(0);
    expect(drawer()!.textContent).toContain("padmakara.statistics.detailLoadFailed");
  });

  it("should open the event edit page from the detail", async () => {
    await openDrawerFor(0);
    click(drawer()!.querySelector('[data-testid="open-event"]')!);
    expect(mockNavigate).toHaveBeenCalledWith("/events/2");
  });

  it("should refetch with the new dates when the range changes", async () => {
    expect(mockFetch).toHaveBeenCalledTimes(1);
    click(container.querySelector('[data-testid="range-90"]')!);
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const url = mockFetch.mock.calls[1]![0] as string;
    const { from, to } = rangeFor(90);
    expect(url).toBe(`/api/admin/statistics?from=${from}&to=${to}`);
  });

  it("should show an error message when the request fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    click(container.querySelector('[data-testid="range-7"]')!);
    await flush();
    expect(text()).toContain("padmakara.statistics.loadFailed");
  });
});

describe("rangeFor", () => {
  it("should span the given number of days ending on the given date", () => {
    expect(rangeFor(7, new Date(2026, 10, 13))).toEqual({ from: "2026-11-07", to: "2026-11-13" });
  });

  it("should cross month boundaries", () => {
    expect(rangeFor(30, new Date(2026, 10, 13))).toEqual({ from: "2026-10-15", to: "2026-11-13" });
  });
});
