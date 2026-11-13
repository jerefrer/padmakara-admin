/** Batch members card: pasted emails, the result summary and the confirmed removal. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("../utils/authFetch", () => ({ authFetch }));
vi.mock("react-admin", () => ({
  useTranslate: () => (key: string, opts?: object) => (opts ? key + JSON.stringify(opts) : key),
  useNotify: () => vi.fn(),
}));

import { BatchMembersCard, splitEmails } from "./BatchMembersCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENDPOINT = "/api/admin/events/12/participants";
const PREFIX = "padmakara.participants";
const MEMBERS = [
  { id: 1, email: "ana@example.com", name: "Ana Silva", registeredAt: "2026-11-01T10:00:00Z" },
  { id: 2, email: "rui@example.com", name: "", registeredAt: "2026-11-02T10:00:00Z" },
];

let container: HTMLDivElement;
let root: Root;

const jsonResponse = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
const flush = () => act(async () => { await Promise.resolve(); });
const mount = async () => {
  await act(async () => root.render(<BatchMembersCard endpoint={ENDPOINT} i18nPrefix={PREFIX} />));
  await flush();
};
const buttonWith = (text: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
const setValue = (el: HTMLTextAreaElement | HTMLInputElement, text: string) =>
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const textarea = () => container.querySelector("textarea:not([aria-hidden])") as HTMLTextAreaElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  authFetch.mockReset();
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return jsonResponse({ added: ["new@x.com", "old@x.com"], alreadyHad: [], created: ["new@x.com"], invalid: ["bad"] });
    }
    if (init?.method === "DELETE") return jsonResponse(null);
    return jsonResponse(MEMBERS);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("splitEmails", () => {
  it("should split a pasted spreadsheet column, row and mixed separators", () => {
    expect(splitEmails("a@x.com\nb@x.com\r\n\tc@x.com, d@x.com;e@x.com  f@x.com\n")).toEqual([
      "a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com",
    ]);
  });
});

describe("BatchMembersCard", () => {
  it("should list the current people with their count", async () => {
    await mount();
    expect(authFetch).toHaveBeenCalledWith(ENDPOINT);
    expect(container.textContent).toContain("Ana Silva");
    expect(container.textContent).toContain("rui@example.com");
    expect(container.textContent).toContain('listTitle{"count":2}');
  });

  it("should send each pasted email once and list the accounts it created", async () => {
    await mount();
    setValue(textarea(), "new@x.com\nold@x.com\tbad,\n");
    await act(async () => buttonWith("addCount").click());
    await flush();

    const post = authFetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[0]).toBe(ENDPOINT);
    expect(JSON.parse(post[1].body)).toEqual({ emails: ["new@x.com", "old@x.com", "bad"] });

    const created = container.querySelector('[data-testid="batch-created"]')!;
    expect(created.textContent).toContain("new@x.com");
    expect(created.textContent).toContain("resultCreatedHint");
    expect(container.textContent).toContain('resultInvalid{"emails":"bad"}');
    expect(textarea().value).toBe("");
  });

  it("should not remove anyone until the admin confirms", async () => {
    await mount();
    const removeButton = container.querySelector(`button[aria-label="${PREFIX}.remove"]`) as HTMLButtonElement;
    act(() => removeButton.click());
    expect(document.body.textContent).toContain('removeBody{"email":"ana@example.com"}');
    expect(authFetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    await act(async () => (document.querySelector('[data-testid="confirm-change-ok"]') as HTMLButtonElement).click());
    await flush();
    expect(authFetch).toHaveBeenCalledWith(`${ENDPOINT}/1`, { method: "DELETE" });
  });

  it("should keep the person when the admin cancels the removal", async () => {
    await mount();
    act(() => (container.querySelector(`button[aria-label="${PREFIX}.remove"]`) as HTMLButtonElement).click());
    act(() => (document.querySelector('[data-testid="confirm-change-cancel"]') as HTMLButtonElement).click());
    expect(authFetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("should offer a filter only for a long list", async () => {
    await mount();
    expect(container.querySelector(`input[aria-label="${PREFIX}.filterPlaceholder"]`)).toBeNull();

    const many = Array.from({ length: 11 }, (_, i) => ({ id: i + 10, email: `p${i}@x.com`, name: "", registeredAt: "2026-11-01T10:00:00Z" }));
    authFetch.mockImplementation(async () => jsonResponse(many));
    act(() => root.unmount());
    root = createRoot(container);
    await mount();
    const filter = container.querySelector(`input[aria-label="${PREFIX}.filterPlaceholder"]`) as HTMLInputElement;
    expect(filter).not.toBeNull();
    setValue(filter, "p3@");
    expect(container.textContent).toContain("p3@x.com");
    expect(container.textContent).not.toContain("p4@x.com");
  });
});
