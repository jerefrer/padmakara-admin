// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => mockNavigate }));
vi.mock("react-admin", () => ({
  Title: () => null,
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
    { id: 1, title: "Alpha", titlePt: null, listeners: 5, completedTracks: 1, listenHours: 2, videoViewers: 0, transcriptOpens: 9, fileOpens: 0, videoStarts: 0, zipDownloads: 0 },
    { id: 2, title: "Beta", titlePt: null, listeners: 8, completedTracks: 4, listenHours: 1, videoViewers: 3, transcriptOpens: 1, fileOpens: 0, videoStarts: 0, zipDownloads: 2 },
  ],
};

let container: HTMLDivElement;
let root: Root;

const text = () => container.textContent ?? "";
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const rowTitles = () =>
  Array.from(container.querySelectorAll('[data-testid="event-row"]')).map((r) => r.querySelector("td")!.textContent);
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

beforeEach(async () => {
  mockFetch.mockReset().mockResolvedValue({ ok: true, json: async () => RESPONSE });
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

  it("should list the events with their counts", () => {
    expect(rowTitles()).toEqual(["Alpha", "Beta"]);
    expect(text()).toContain("padmakara.statistics.privacyNote");
  });

  it("should show the platforms with friendly names and counts", () => {
    expect(text()).toContain("iPhone");
    expect(text()).toContain("Android");
    expect(text()).toContain("Web");
    expect(text()).toContain("50");
  });

  it("should show monthly income in euros", () => {
    expect(text()).toContain("€15");
    expect(text()).toContain("€25");
  });

  it("should sort the events table by a column, descending first, then ascending", () => {
    const header = container.querySelector('[data-testid="sort-listeners"]')!;
    click(header);
    expect(rowTitles()).toEqual(["Beta", "Alpha"]);
    click(header);
    expect(rowTitles()).toEqual(["Alpha", "Beta"]);
  });

  it("should open the event edit page when a row is clicked", () => {
    click(container.querySelectorAll('[data-testid="event-row"]')[1]!);
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
