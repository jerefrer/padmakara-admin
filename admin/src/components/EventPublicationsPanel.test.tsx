/** "Related texts" tick list on the event edit page. */

import { act, useState } from "react";
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

const pub = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Pub ${id}`,
  language: "pt",
  version: null,
  status: "published",
  ...extra,
});
const respond = (body: unknown) =>
  authFetch.mockResolvedValueOnce({ ok: true, json: async () => body });

const seen: { ids: number[] | null } = { ids: null };

/** The page's job: owns the ticked ids and receives the loaded ones. */
const Harness = () => {
  const [ids, setIds] = useState<number[] | null>(null);
  seen.ids = ids;
  return (
    <EventPublicationsPanel eventId={7} selectedIds={ids} onLoaded={setIds} onChange={setIds} />
  );
};

const mount = async () => {
  await act(async () => root.render(<Harness />));
  await flush();
};
const boxes = (): HTMLInputElement[] => [
  ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
];

beforeEach(() => {
  seen.ids = null;
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
  it("should list the group publications with a tick box each, ticked only when linked", async () => {
    respond({ selectedIds: [6], viaGroups: [pub(5), pub(6)], others: [] });
    await mount();

    expect(authFetch).toHaveBeenCalledWith("/api/admin/events/7/publications");
    expect(boxes().map((b) => b.checked)).toEqual([false, true]);
    expect(container.textContent).toContain("Pub 5");
    expect(seen.ids).toEqual([6]);
  });

  it("should tick nothing by itself when no publication is linked yet", async () => {
    respond({ selectedIds: [], viaGroups: [pub(5)], others: [] });
    await mount();

    expect(boxes()[0]!.checked).toBe(false);
    expect(seen.ids).toEqual([]);
  });

  it("should add an id to the ticks when a publication is ticked and remove it when unticked", async () => {
    respond({ selectedIds: [6], viaGroups: [pub(5), pub(6)], others: [] });
    await mount();

    await act(async () => boxes()[0]!.click());
    expect(seen.ids).toEqual([6, 5]);

    await act(async () => boxes()[1]!.click());
    expect(seen.ids).toEqual([5]);
  });

  it("should show a ticked publication outside the groups as a chip in the picker", async () => {
    respond({ selectedIds: [9], viaGroups: [pub(5)], others: [pub(9), pub(10)] });
    await mount();

    const chips = [...container.querySelectorAll(".MuiChip-label")].map((c) => c.textContent);
    expect(chips).toEqual(["Pub 9 (PT)"]);
  });

  it("should keep group ticks when an outside publication is picked", async () => {
    respond({ selectedIds: [5], viaGroups: [pub(5)], others: [pub(9)] });
    await mount();

    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await act(async () => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const option = document.body.querySelector<HTMLElement>('[role="option"]')!;
    await act(async () => option.click());

    expect(seen.ids).toEqual([5, 9]);
  });

  it("should render nothing when there is no publication at all", async () => {
    respond({ selectedIds: [], viaGroups: [], others: [] });
    await mount();
    expect(container.textContent).toBe("");
  });

  it("should render nothing when the request fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    authFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await mount();
    expect(container.textContent).toBe("");
    expect(seen.ids).toBeNull();
    err.mockRestore();
  });
});
