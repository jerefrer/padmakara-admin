// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockEvent: { titleEn: string; titlePt: string | null } | undefined;
vi.mock("react-admin", () => ({
  AppBar: () => null,
  Sidebar: () => null,
  CheckForApplicationUpdate: () => null,
  useResourceDefinitions: () => ({ events: {}, users: {} }),
  useGetResourceLabel: () => (name: string) => (name === "events" ? "Events" : "Users"),
  useGetOne: (_r: string, _p: unknown, o?: { enabled?: boolean }) => ({ data: o?.enabled ? mockEvent : undefined }),
  useLocaleState: () => ["en", vi.fn()],
}));
vi.mock("./Menu", () => ({ Menu: () => null }));
vi.mock("../components/LanguageSwitcher", () => ({ LanguageSwitcher: () => null }));
vi.mock("../components/IncompleteAudioBanner", () => ({ IncompleteAudioBanner: () => null }));

import { PageTitle } from "./Layout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const renderAt = (path: string) =>
  act(() => root.render(<MemoryRouter initialEntries={[path]}><PageTitle /></MemoryRouter>));

beforeEach(() => {
  mockEvent = undefined;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("PageTitle breadcrumb", () => {
  it("should link the resource label to its list on an edit page", () => {
    renderAt("/events/924");
    expect(host.querySelector("a")!.getAttribute("href")).toBe("/events");
  });

  it("should show the event title instead of the id when it is loaded", () => {
    mockEvent = { titleEn: "Guru Yoga | Spring Retreat 2025", titlePt: null };
    renderAt("/events/924");
    expect(host.textContent).toContain("/ Guru Yoga | Spring Retreat 2025");
  });

  it("should fall back to the id while the event is not loaded", () => {
    renderAt("/events/924");
    expect(host.textContent).toContain("/ #924");
  });

  it("should keep the id for other resources", () => {
    mockEvent = { titleEn: "Should not show", titlePt: null };
    renderAt("/users/7");
    expect(host.textContent).toContain("/ #7");
  });

  it("should not render the label as a link on a list page", () => {
    renderAt("/events");
    expect(host.querySelector("a")).toBeNull();
  });
});
