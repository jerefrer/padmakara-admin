/**
 * The event edit form sent every field on Save. A tab opened before another
 * admin's change (it only fetches the event when it opens) therefore wrote its
 * older copy of every field back over that change. Save now sends only the
 * fields changed in this form since it loaded.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { CoreAdminContext, type DataProvider } from "react-admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/authFetch", () => ({
  authFetch: vi.fn(async () => new Response("{}", { status: 404 })),
}));

import { EventEdit } from "./events";

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

const EVENT_ID = 7;
const EVENT = {
  id: EVENT_ID,
  eventCode: "2026-04-RET",
  titleEn: "Spring retreat",
  titlePt: "Retiro de primavera",
  titleEnReviewed: true,
  titlePtReviewed: true,
  mainThemesEn: "Refuge",
  status: "draft",
  sessions: [],
  videos: [],
  transcripts: [],
  eventTeachers: [],
  eventPlaces: [],
  eventRetreatGroups: [],
  organizers: [],
  internalNotes: "",
};

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});

async function open() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const update = vi.fn(async (_resource: string, params: { data: unknown }) => ({ data: params.data }));
  const dataProvider = {
    getList: vi.fn(async () => ({ data: [], total: 0 })),
    getOne: vi.fn(async () => ({ data: structuredClone(EVENT) })),
    update,
  } as unknown as DataProvider;
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[`/events/${EVENT_ID}`]}>
        <CoreAdminContext dataProvider={dataProvider} queryClient={queryClient}>
          <Routes>
            <Route path="/events/:id" element={<EventEdit />} />
          </Routes>
        </CoreAdminContext>
      </MemoryRouter>,
    ),
  );
  await flush();
  return { update };
}

const typeNotes = (value: string) => {
  const field = host.querySelector('[data-testid="internal-notes"] textarea') as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const clickSave = async () => {
  const save = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("padmakara.events.saveChanges"),
  ) as HTMLButtonElement;
  await act(async () => save.click());
  await flush();
};

const eventSaves = (update: ReturnType<typeof vi.fn>) =>
  update.mock.calls.filter(([r]) => r === "events").map(([, params]) => (params as { data: Record<string, unknown> }).data);

describe("EventEdit Save sends only what changed", () => {
  it("should send only the field edited in this form", async () => {
    const { update } = await open();
    typeNotes("Sound check on Friday");
    await clickSave();

    expect(eventSaves(update)).toEqual([{ internalNotes: "Sound check on Friday" }]);
  });

  it("should send a second edit alone after a first Save", async () => {
    const { update } = await open();
    typeNotes("Sound check on Friday");
    await clickSave();
    typeNotes("Sound check on Saturday");
    await clickSave();

    expect(eventSaves(update)[1]).toEqual({ internalNotes: "Sound check on Saturday" });
  });

  it("should send a changed text together with its reviewed flag", async () => {
    const { update } = await open();
    const input = [...host.querySelectorAll("input")].find((el) => el.value === "Spring retreat") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, "Spring retreat 2026");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickSave();

    expect(eventSaves(update)).toEqual([{ titleEn: "Spring retreat 2026", titleEnReviewed: true }]);
  });

  it("should write no event field when nothing was changed", async () => {
    const { update } = await open();
    await clickSave();

    expect(eventSaves(update)).toEqual([]);
  });
});
