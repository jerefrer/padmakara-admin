/**
 * The delete confirmations name the event or group being deleted. Those names
 * are free text (typed by any admin, imported from CSV, suggested by the AI
 * assistant), so they must show as text: never parsed as HTML in the browser
 * of the admin who opens the dialog.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { AdminContext, ResourceContextProvider, type DataProvider } from "react-admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/authFetch", () => ({
  authFetch: vi.fn(async () => new Response("{}", { status: 404 })),
}));

import { i18nProvider } from "../i18n";
import { EventEdit } from "./events";
import { GroupEdit } from "./groups";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOSTILE_NAME = '<img src="x" data-injected="1" onerror="window.__xss = 1">';

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

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});

async function renderAt(resource: string, id: number, element: React.ReactNode, record: object) {
  const dataProvider = {
    getList: vi.fn(async () => ({ data: [], total: 0 })),
    getOne: vi.fn(async () => ({ data: record })),
    getMany: vi.fn(async () => ({ data: [] })),
    getManyReference: vi.fn(async () => ({ data: [], total: 0 })),
    update: vi.fn(async (_r: string, params: { data: unknown }) => ({ data: params.data })),
  } as unknown as DataProvider;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[`/${resource}/${id}`]}>
        <AdminContext dataProvider={dataProvider} queryClient={queryClient} i18nProvider={i18nProvider}>
          <Routes>
            <Route
              path={`/${resource}/:id`}
              element={<ResourceContextProvider value={resource}>{element}</ResourceContextProvider>}
            />
          </Routes>
        </AdminContext>
      </MemoryRouter>,
    ),
  );
  await flush();
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  expect(button, `button "${label}"`).toBeTruthy();
  await act(async () => (button as HTMLButtonElement).click());
  await flush();
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;

describe("delete confirmation dialogs", () => {
  it("should show an event title containing markup as text when the delete dialog opens", async () => {
    // Arrange
    await renderAt("events", 7, <EventEdit />, {
      id: 7,
      eventCode: "2026-04-RET",
      titleEn: HOSTILE_NAME,
      status: "draft",
      sessions: [],
      videos: [],
      transcripts: [],
      eventTeachers: [],
      eventPlaces: [],
      eventRetreatGroups: [],
      organizers: [],
    });

    // Act
    await clickButton("Delete");

    // Assert
    expect(dialog()?.querySelector("[data-injected]")).toBeNull();
    expect(dialog()?.querySelector("strong")?.textContent).toBe(HOSTILE_NAME);
  });

  it("should show a group name containing markup as text when the delete dialog opens", async () => {
    // Arrange
    await renderAt("groups", 3, <GroupEdit />, {
      id: 3,
      nameEn: HOSTILE_NAME,
      slug: "hostile",
    });

    // Act
    await clickButton("Delete Group");

    // Assert
    expect(dialog()?.querySelector("[data-injected]")).toBeNull();
    expect(dialog()?.querySelector("strong")?.textContent).toBe(HOSTILE_NAME);
  });
});
