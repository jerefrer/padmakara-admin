/** The event page's sections: Topics holds the themes, and the "show in app" tick boxes sit in the headers. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-admin")>();
  return {
    ...actual,
    useTranslate: () => (key: string) => key,
    useLocaleState: () => ["en", vi.fn()],
    useNotify: () => vi.fn(),
    useRefresh: () => vi.fn(),
    useDataProvider: () => ({}),
  };
});

import { EventFormFields, EMPTY_FORM, type EventFormData } from "./events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const FLAGS = {
  audioPublished: true,
  videoPublished: false,
  transcriptsPublished: true,
  textsPublished: true,
  topicsPublished: true,
};

function renderForm(over: {
  form?: Partial<EventFormData>;
  onToggle?: (id: string) => void;
  visibility?: { flags: typeof FLAGS; onChange: (key: string, value: boolean) => void };
}) {
  const noop = vi.fn();
  const props: any = {
    form: { ...EMPTY_FORM, titleEn: "T", mainThemesEn: "Compassion\nPatience", ...over.form },
    setForm: noop,
    selectedTeachers: [], setSelectedTeachers: noop,
    selectedPlaces: [], setSelectedPlaces: noop,
    selectedOrganizers: [], setSelectedOrganizers: noop,
    selectedGroups: [], setSelectedGroups: noop,
    selectedEventType: null, setSelectedEventType: noop,
    selectedAudience: null, setSelectedAudience: noop,
    allTeachers: [], allPlaces: [], allOrganizers: [], allGroups: [], allEventTypes: [], allAudiences: [],
    sessions: [], transcripts: [],
    trackCount: 0, transcriptCount: 0,
    collapsible: { open: { topics: true }, onToggle: over.onToggle ?? vi.fn() },
    visibility: over.visibility,
  };
  act(() => root.render(<EventFormFields {...props} />));
}

const section = (id: string) => host.querySelector(`[data-section="${id}"]`) as HTMLElement | null;
const tick = (flag: string) =>
  host.querySelector(`input[data-visibility="${flag}"]`) as HTMLInputElement | null;

describe("Topics section", () => {
  it("should hold the main and session theme fields, not the details section", () => {
    renderForm({});
    const topics = section("topics")!;
    expect(topics.textContent).toContain("padmakara.events.mainThemesEn");
    expect(topics.textContent).toContain("padmakara.events.sessionThemesPt");
    expect(section("details")!.textContent).not.toContain("padmakara.events.mainThemesEn");
  });

  it("should come after Transcription and before Related texts", () => {
    renderForm({});
    const order = Array.from(host.querySelectorAll("[data-section]")).map((n) => n.getAttribute("data-section"));
    expect(order.indexOf("topics")).toBe(order.indexOf("transcription") + 1);
    expect(order.indexOf("texts")).toBe(order.indexOf("topics") + 1);
  });

  it("should count the filled topic lines in its summary", () => {
    renderForm({});
    expect(section("topics")!.textContent).toContain("padmakara.eventSections.mainTopicsSummary");
  });
});

describe("show-in-app tick boxes", () => {
  it("should not show any tick box without visibility settings (a draft)", () => {
    renderForm({});
    expect(host.querySelector("input[data-visibility]")).toBeNull();
  });

  it("should show one tick box per flag in its section header when published", () => {
    renderForm({ visibility: { flags: FLAGS, onChange: vi.fn() } });
    expect(section("media")!.contains(tick("audioPublished"))).toBe(true);
    expect(section("media")!.contains(tick("videoPublished"))).toBe(true);
    expect(section("transcription")!.contains(tick("transcriptsPublished"))).toBe(true);
    expect(section("topics")!.contains(tick("topicsPublished"))).toBe(true);
    expect(section("texts")!.contains(tick("textsPublished"))).toBe(true);
  });

  it("should reflect the flags: ticked when visible, unticked when hidden", () => {
    renderForm({ visibility: { flags: FLAGS, onChange: vi.fn() } });
    expect(tick("audioPublished")!.checked).toBe(true);
    expect(tick("videoPublished")!.checked).toBe(false);
  });

  it("should report the right flag and value when a box is clicked", () => {
    const onChange = vi.fn();
    renderForm({ visibility: { flags: FLAGS, onChange } });

    act(() => tick("topicsPublished")!.click());
    act(() => tick("videoPublished")!.click());

    expect(onChange).toHaveBeenNthCalledWith(1, "topicsPublished", false);
    expect(onChange).toHaveBeenNthCalledWith(2, "videoPublished", true);
  });

  it("should not fold the section when its tick box is clicked", () => {
    const onToggle = vi.fn();
    renderForm({ onToggle, visibility: { flags: FLAGS, onChange: vi.fn() } });

    act(() => tick("topicsPublished")!.click());
    expect(onToggle).not.toHaveBeenCalled();

    act(() => (host.querySelector("#topics-header") as HTMLButtonElement).click());
    expect(onToggle).toHaveBeenCalledWith("topics");
  });
});
