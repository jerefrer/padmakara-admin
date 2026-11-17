/**
 * Authors on the publication edit page: an admin must be able to add a second
 * author to a publication that already has one (reported by Sofia: the old
 * comma-separated text field swallowed every separator she typed, so she could
 * erase the name but never add "Mañjuśrī"), picking names already in use.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { CoreAdminContext, ResourceContextProvider, type DataProvider } from "react-admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The authors already used across publications, as GET /publications/authors lists them.
vi.mock("../utils/authFetch", () => ({
  authFetch: vi.fn(async (url: string) =>
    url === "/api/admin/publications/authors"
      ? new Response(
          JSON.stringify([
            { name: "Buda Śākyamuni (BS)", count: 3 },
            { name: "Mañjuśrī", count: 1 },
          ]),
          { status: 200 },
        )
      : new Response("{}", { status: 404 }),
  ),
}));

import { PublicationEdit } from "./publications";

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

const PUBLICATION = {
  id: 8,
  title: "Sutra do Coração",
  authors: ["Buda Śākyamuni (BS)"],
  language: "pt",
  audienceId: 1,
  pdfS3Key: "publications/pdfs/8.pdf",
  eventIds: [],
  retreatGroupIds: [],
  accessUserIds: [],
  accessUsers: [],
};

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });

async function open() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const dataProvider = {
    getList: vi.fn(async () => ({ data: [], total: 0 })),
    getOne: vi.fn(async () => ({ data: PUBLICATION })),
    update: vi.fn(async (_resource: string, params: { data: unknown }) => ({ data: params.data })),
  } as unknown as DataProvider;

  act(() =>
    root.render(
      <MemoryRouter initialEntries={[`/publications/${PUBLICATION.id}`]}>
        <CoreAdminContext dataProvider={dataProvider} queryClient={queryClient}>
          <Routes>
            <Route
              path="/publications/:id"
              element={
                <ThemeProvider theme={createTheme()}>
                  <ResourceContextProvider value="publications">
                    <PublicationEdit />
                  </ResourceContextProvider>
                </ThemeProvider>
              }
            />
          </Routes>
        </CoreAdminContext>
      </MemoryRouter>,
    ),
  );
  await flush();
}

const authorsInput = () => host.querySelector<HTMLInputElement>('[data-testid="authors-input"] input')!;
const chips = () =>
  [...host.querySelectorAll('[data-testid="authors-input"] .MuiChip-label')].map((c) => c.textContent);
const suggestions = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);

function type(text: string) {
  const input = authorsInput();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    input.focus();
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressEnter() {
  act(() => {
    authorsInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("PublicationEdit authors", () => {
  it("should add a second author next to the first one", async () => {
    // Arrange
    await open();

    // Act
    type("Mañjuśrī");
    pressEnter();

    // Assert
    expect(chips()).toEqual(["Buda Śākyamuni (BS)", "Mañjuśrī"]);
  });

  it("should suggest a name already in use when it is typed without case or diacritics", async () => {
    // Arrange
    await open();

    // Act
    type("manjus");

    // Assert
    expect(suggestions()).toEqual(["Mañjuśrī"]);
  });

  it("should store a typed variant of a name in use with the spelling already in use", async () => {
    // Arrange
    await open();

    // Act
    type("manjusri");
    pressEnter();

    // Assert
    expect(chips()).toEqual(["Buda Śākyamuni (BS)", "Mañjuśrī"]);
  });

  it("should still accept a new name nobody has used yet", async () => {
    // Arrange
    await open();

    // Act
    type("Patrul Rinpoche");
    pressEnter();

    // Assert
    expect(chips()).toEqual(["Buda Śākyamuni (BS)", "Patrul Rinpoche"]);
  });
});
