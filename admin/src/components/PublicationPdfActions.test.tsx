/**
 * Preview and download buttons on the publication edit page. Mounted with
 * react-dom directly, like the other component tests here.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("../utils/authFetch", () => ({ authFetch }));
vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
  useNotify: () => vi.fn(),
}));

import { PublicationPdfActions } from "./PublicationPdfActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  authFetch.mockReset();
  authFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ url: "https://s3.example.com/x" }) });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<PublicationPdfActions publicationId={7} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

describe("PublicationPdfActions", () => {
  it("should open the inline URL in a new tab when Preview is clicked", async () => {
    const tab = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);

    await act(async () => button("padmakara.publications.pdfPreview").click());

    expect(authFetch).toHaveBeenCalledWith("/api/admin/publications/7/pdf-url?disposition=inline");
    expect(tab.location.href).toBe("https://s3.example.com/x");
  });

  it("should request the attachment URL when Download is clicked", async () => {
    const open = vi.spyOn(window, "open");

    await act(async () => button("padmakara.publications.pdfDownload").click());

    expect(authFetch).toHaveBeenCalledWith("/api/admin/publications/7/pdf-url?disposition=attachment");
    expect(open).not.toHaveBeenCalled();
  });

  it("should close the blank tab when the URL cannot be fetched", async () => {
    const tab = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    authFetch.mockResolvedValue({ ok: false, status: 404 });

    await act(async () => button("padmakara.publications.pdfPreview").click());

    expect(tab.close).toHaveBeenCalled();
  });
});
