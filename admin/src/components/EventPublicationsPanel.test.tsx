/** Read-only publications panel on the event edit page. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("../utils/authFetch", () => ({ authFetch }));
vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
}));

import { EventPublicationsPanel } from "./EventPublicationsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

const respond = (body: unknown) =>
  authFetch.mockResolvedValueOnce({ ok: true, json: async () => body });

const mount = async () => {
  await act(async () => root.render(<EventPublicationsPanel eventId={7} />));
  await flush();
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("EventPublicationsPanel", () => {
  it("should list group-linked publications with a link to their edit page", async () => {
    respond({ viaGroups: [{ id: 5, title: "Ngondro Guide", language: "pt", version: "2" }], direct: [] });
    await mount();
    expect(authFetch).toHaveBeenCalledWith("/api/admin/events/7/publications");
    const link = container.querySelector("a") as HTMLAnchorElement;
    expect(link.textContent).toBe("Ngondro Guide");
    expect(link.getAttribute("href")).toBe("#/publications/5");
    expect(container.textContent).toContain("PT");
    expect(container.textContent).toContain("2");
  });

  it("should label legacy direct links separately", async () => {
    respond({ viaGroups: [], direct: [{ id: 9, title: "Old Text", language: "en", version: null }] });
    await mount();
    expect(container.textContent).toContain("padmakara.eventPublications.direct");
    expect(container.textContent).toContain("Old Text");
  });

  it("should render nothing when the event has no publications", async () => {
    respond({ viaGroups: [], direct: [] });
    await mount();
    expect(container.textContent).toBe("");
  });

  it("should render nothing when the request fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    authFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await mount();
    expect(container.textContent).toBe("");
    err.mockRestore();
  });
});
