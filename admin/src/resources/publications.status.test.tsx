/**
 * The publication edit page shows the publication's status (Draft /
 * Forthcoming / Published) and says what that status does in the app.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { CoreAdminContext, ResourceContextProvider, type DataProvider } from "react-admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/authFetch", () => ({
  authFetch: vi.fn(async () => new Response("[]", { status: 200 })),
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

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });

async function openWithStatus(status: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const dataProvider = {
    getList: vi.fn(async () => ({ data: [], total: 0 })),
    getOne: vi.fn(async () => ({
      data: {
        id: 8,
        title: "Sutra do Coração",
        authors: [],
        language: "pt",
        audienceId: 1,
        pdfS3Key: "publications/pdfs/8.pdf",
        status,
        eventIds: [],
        retreatGroupIds: [],
        accessUserIds: [],
        accessUsers: [],
      },
    })),
    update: vi.fn(),
  } as unknown as DataProvider;

  act(() =>
    root.render(
      <MemoryRouter initialEntries={["/publications/8"]}>
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

describe("PublicationEdit status", () => {
  it("should show a forthcoming publication as forthcoming, with what that means in the app", async () => {
    await openWithStatus("forthcoming");

    expect(host.querySelector('input[name="status"]')?.getAttribute("value")).toBe("forthcoming");
    expect(host.textContent).toContain("padmakara.publications.statusForthcoming");
    expect(host.textContent).toContain("padmakara.publications.statusHelperForthcoming");
  });

  it("should say a draft is seen by admins only", async () => {
    await openWithStatus("draft");

    expect(host.textContent).toContain("padmakara.publications.statusHelperDraft");
  });
});
