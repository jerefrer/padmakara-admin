/**
 * The event edit form starts from the server's current event, not from the
 * copy react-admin still holds in its query cache. That copy is either the
 * list row (which never carries the internal notes) or the event as it was
 * fetched before the last Save, since the page saves through
 * dataProvider.update and never touches the cache.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { CoreAdminContext, type DataProvider } from "react-admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every side panel of the page (publications, documents, access…) calls the API
// directly; a refusal keeps them quiet (they only show what loaded).
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
const BASE_EVENT = {
  id: EVENT_ID,
  eventCode: "2026-04-RET",
  titleEn: "Spring retreat",
  titlePt: "Retiro de primavera",
  status: "draft",
  sessions: [],
  videos: [],
  transcripts: [],
  eventTeachers: [],
  eventPlaces: [],
  eventRetreatGroups: [],
  organizers: [],
};

/** Resolves on demand, so the test decides which request answers first. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets pending requests settle; react-query notifies its observers on a timer. */
const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});

const SAVED_NOTES = "Video of last 3 sessions missing";

/**
 * Opens the edit page with the cache holding the event as first opened (no
 * notes) while the server has the notes saved since. The lookups answer before
 * the event refetch, as they usually do (six small lists against one heavy
 * event query), and the refetch answers once the page has settled.
 */
async function openWithStaleCache() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(
    ["events", "getOne", { id: String(EVENT_ID), meta: undefined }],
    { ...BASE_EVENT, internalNotes: "" },
  );
  const freshEvent = deferred<{ data: unknown }>();
  const update = vi.fn(async (_resource: string, params: { data: unknown }) => ({ data: params.data }));
  const dataProvider = {
    getList: vi.fn(async () => ({ data: [], total: 0 })),
    getOne: vi.fn(() => freshEvent.promise),
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
  freshEvent.resolve({ data: { ...BASE_EVENT, internalNotes: SAVED_NOTES } });
  await flush();
  return { update };
}

const notesField = () =>
  host.querySelector('[data-testid="internal-notes"] textarea') as HTMLTextAreaElement | null;

describe("EventEdit form initialisation", () => {
  it("should show the saved internal notes when the query cache still holds the event from before the save", async () => {
    // Arrange + Act
    await openWithStaleCache();

    // Assert
    expect(notesField()?.value).toBe(SAVED_NOTES);
  });

  it("should keep the saved internal notes when Save is clicked after opening from a stale cache", async () => {
    // Arrange
    const { update } = await openWithStaleCache();
    const save = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("padmakara.events.saveChanges"),
    ) as HTMLButtonElement;

    // Act
    await act(async () => save.click());
    await flush();

    // Assert: a blank value here would delete the notes row on the server.
    // (Save sends only what was changed in the form, so the notes are not sent at all.)
    const sentNotes = update.mock.calls.map(([, params]) => (params as { data: Record<string, unknown> }).data);
    expect(sentNotes.every((data) => !("internalNotes" in data) || data.internalNotes === SAVED_NOTES)).toBe(true);
  });
});
