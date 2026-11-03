/** "People with access" card on the event page. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("../utils/authFetch", () => ({ authFetch }));
vi.mock("react-admin", () => ({
  useTranslate: () => (key: string, opts?: object) => (opts ? key + JSON.stringify(opts) : key),
  useNotify: () => vi.fn(),
}));

import { EventAccessSection } from "./EventAccessSection";
import type { EventAccess } from "./useEventAccess";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const reload = vi.fn();

const access: EventAccess = {
  grants: [
    {
      userId: 5, email: "ana@example.com", name: "Ana Silva", source: "purchase", orderId: 1,
      method: "mbw", amountCents: 1500, createdAt: "2026-11-01T10:00:00Z", grantedBy: null,
    },
    {
      userId: 6, email: "rui@example.com", name: "", source: "manual", orderId: null,
      method: null, amountCents: null, createdAt: "2026-11-02T10:00:00Z",
      grantedBy: { id: 1, email: "admin@x.pt", name: "Maria Admin" },
    },
  ],
  pendingOrders: [
    { id: 9, email: "wait@example.com", name: "Waiting Person", amountCents: 1500, createdAt: "2026-11-03T09:00:00Z" },
  ],
  stats: { paidCount: 1, collectedCents: 1500, pendingCount: 1 },
};

const mount = () => act(() => root.render(<EventAccessSection eventId={42} access={access} reload={reload} />));
const buttonWith = (text: string, scope: ParentNode = container) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const setValue = (el: HTMLTextAreaElement | HTMLInputElement, text: string) =>
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

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

describe("EventAccessSection", () => {
  it("should describe how each person got access", () => {
    mount();
    expect(container.textContent).toContain("Ana Silva");
    expect(container.textContent).toContain("ana@example.com");
    expect(container.textContent).toContain("€15");
    expect(container.textContent).toContain("MB WAY");
    expect(container.textContent).toContain("padmakara.eventAccess.givenBy");
  });

  it("should list pending orders separately", () => {
    mount();
    expect(container.textContent).toContain("wait@example.com");
  });

  it("should post trimmed emails and the notify choice, then show the summary", async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ added: ["a@x.pt"], alreadyHad: ["b@x.pt"], invalid: ["nope"] }),
    });
    mount();
    setValue(container.querySelector("textarea") as HTMLTextAreaElement, "  a@x.pt \n\nb@x.pt\nnope  ");
    await act(async () => buttonWith("padmakara.eventAccess.give").click());
    expect(authFetch).toHaveBeenCalledTimes(1);
    const [url, init] = authFetch.mock.calls[0];
    expect(url).toBe("/api/admin/events/42/access");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      emails: ["a@x.pt", "b@x.pt", "nope"],
      notify: true,
      language: "pt",
    });
    expect(reload).toHaveBeenCalled();
    expect(container.textContent).toContain("resultInvalid");
    expect(container.textContent).toContain("nope");
  });

  it("should send notify false when Email them is unticked", async () => {
    authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ added: [], alreadyHad: [], invalid: [] }) });
    mount();
    setValue(container.querySelector("textarea") as HTMLTextAreaElement, "a@x.pt");
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => buttonWith("padmakara.eventAccess.give").click());
    expect(JSON.parse(authFetch.mock.calls[0][1].body).notify).toBe(false);
  });

  it("should call DELETE after confirming Remove", async () => {
    authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    mount();
    act(() => container.querySelectorAll<HTMLButtonElement>('button[aria-label="padmakara.eventAccess.remove"]')[0].click());
    expect(authFetch).not.toHaveBeenCalled();
    await act(async () => buttonWith("padmakara.eventAccess.confirmRemove", document.body).click());
    expect(authFetch).toHaveBeenCalledWith("/api/admin/events/42/access/5", { method: "DELETE" });
    expect(reload).toHaveBeenCalled();
  });
});
