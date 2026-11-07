/** "Library metadata" dialog: the event code row follows the same rules as the other text rows. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("../utils/authFetch", () => ({ authFetch }));
vi.mock("react-admin", () => ({
  useTranslate: () => (key: string, opts?: object) => (opts ? key + JSON.stringify(opts) : key),
  useNotify: () => vi.fn(),
  useLocaleState: () => ["en", vi.fn()],
}));
vi.mock("react-router-dom", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import { LibraryMetadataButton, type LibraryMetadataButtonProps } from "./LibraryMetadataButton";
import type { EventFormData } from "../resources/events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const record = {
  wixId: "w1", eventCode: "2024.04.12-LIB", title: "A teaching", teacherNames: "", guestName: "",
  organization: "", place: "", designation: "", dateRange: "", startDate: null, endDate: null,
};

const mapping = {
  wixId: "w1",
  fields: {
    titlePt: null, startDate: null, endDate: null, mainThemesPt: null, mainThemesEn: null,
    sessionThemesPt: null, sessionThemesEn: null, bibliography: null, eventTypeId: null, audienceId: null,
    groupIds: [], teacherIds: [], placeIds: [], organizerIds: [], wixId: "w1", librarySnapshot: {},
  },
  resolved: { eventType: null, audience: null, groups: [], teachers: [], places: [], organizers: [] },
  unresolved: { teachers: [], places: [], organizers: [], designation: null, audience: null },
};

const EMPTY_FORM = {
  eventCode: "", eventCodeReviewed: true, titleEn: "", titlePt: "", mainThemesPt: "", mainThemesEn: "",
  sessionThemesEn: "", sessionThemesPt: "", titleEnReviewed: true, titlePtReviewed: true,
  mainThemesEnReviewed: true, mainThemesPtReviewed: true,
  sessionThemesEnReviewed: true, sessionThemesPtReviewed: true,
  startDate: "", endDate: "", bibliography: "", bibliographyPt: "",
  bibliographyEnReviewed: true, bibliographyPtReviewed: true,
  wixId: null, librarySnapshot: null, guestTeacherIds: [], status: "draft", featuredAt: null,
  saleMode: "none", priceCents: null, includedInMembership: false, internalNotes: "",
} satisfies EventFormData;

const json = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

let container: HTMLDivElement;
let root: Root;
let form: EventFormData;
const setForm = vi.fn((update: React.SetStateAction<EventFormData>) => {
  form = typeof update === "function" ? update(form) : update;
});

const props = (): LibraryMetadataButtonProps => ({
  form,
  setForm,
  selectedTeachers: [], setSelectedTeachers: vi.fn(),
  selectedPlaces: [], setSelectedPlaces: vi.fn(),
  selectedOrganizers: [], setSelectedOrganizers: vi.fn(),
  selectedGroups: [], setSelectedGroups: vi.fn(),
  selectedEventType: null, setSelectedEventType: vi.fn(),
  selectedAudience: null, setSelectedAudience: vi.fn(),
  allGroups: [], allEventTypes: [], allAudiences: [],
});

/** Opens the dialog and lets the status, suggestion and mapping requests settle. */
const openDialog = async () => {
  await act(async () => root.render(<LibraryMetadataButton {...props()} />));
  await act(async () => {
    container.querySelector("button")!.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const dialogText = () => document.body.textContent ?? "";
const rowCheckbox = (label: string) => {
  const row = [...document.querySelectorAll("tbody tr")].find((r) => r.textContent?.includes(label));
  return row?.querySelector<HTMLInputElement>("input[type=checkbox]") ?? null;
};
const applyButton = () =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === "padmakara.library.apply")!;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  form = { ...EMPTY_FORM };
  authFetch.mockImplementation((url: string) => {
    if (url.endsWith("/status")) return json({ count: 1 });
    if (url.endsWith("/suggest")) return json({ suggestions: [{ ...record, score: 90, reasons: [] }] });
    if (url.includes("/mapping")) return json({ mapping });
    return json({});
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("LibraryMetadataButton event code row", () => {
  it("should offer the library code, checked, when the form has no code yet", async () => {
    await openDialog();

    expect(dialogText()).toContain("2024.04.12-LIB");
    expect(rowCheckbox("padmakara.library.eventCode")?.checked).toBe(true);
  });

  it("should leave the row unchecked when the form already has a different code", async () => {
    form = { ...EMPTY_FORM, eventCode: "OLD-CODE" };
    await openDialog();

    expect(rowCheckbox("padmakara.library.eventCode")?.checked).toBe(false);
  });

  it("should not show the row when the form code already matches the library", async () => {
    form = { ...EMPTY_FORM, eventCode: "2024.04.12-LIB" };
    await openDialog();

    expect(rowCheckbox("padmakara.library.eventCode")).toBeNull();
  });

  it("should write the library code into the form when applied", async () => {
    await openDialog();
    await act(async () => applyButton().click());

    expect(form.eventCode).toBe("2024.04.12-LIB");
  });

  it("should mark the code reviewed when the library code is applied", async () => {
    form = { ...EMPTY_FORM, eventCodeReviewed: false };
    await openDialog();
    await act(async () => applyButton().click());

    expect(form.eventCodeReviewed).toBe(true);
  });

  it("should leave the reviewed flag alone when the row is unchecked", async () => {
    form = { ...EMPTY_FORM, eventCode: "OLD-CODE", eventCodeReviewed: false };
    await openDialog();
    await act(async () => applyButton().click());

    expect(form.eventCodeReviewed).toBe(false);
  });

  it("should keep the form code when the row is unchecked", async () => {
    form = { ...EMPTY_FORM, eventCode: "OLD-CODE" };
    await openDialog();
    await act(async () => applyButton().click());

    expect(form.eventCode).toBe("OLD-CODE");
  });
});
