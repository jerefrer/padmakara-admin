/**
 * The move bar has to stay in view while tracks are ticked: André ticked
 * tracks near the bottom of the page and never saw it above the first session.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key.replace(/^padmakara\./, ""),
}));

import { MoveTracksBar } from "./MoveTracksBar";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(
  selectedCount: number,
  onBulkDelete?: () => void | Promise<void>,
  selectAll?: { totalCount: number; onSelectAll: () => void },
) {
  act(() => {
    root.render(
      <MoveTracksBar
        sessions={[]}
        selectedCount={selectedCount}
        busy={false}
        defaultDate="2026-04-12"
        onMove={() => {}}
        onClear={() => {}}
        onBulkDelete={onBulkDelete}
        totalCount={selectAll?.totalCount}
        onSelectAll={selectAll?.onSelectAll}
      />,
    );
  });
}

describe("MoveTracksBar", () => {
  it("should render nothing when no track is selected", () => {
    render(0);
    expect(container.querySelector("[data-testid=move-tracks-bar]")).toBeNull();
  });

  it("should stick to the top with an opaque background above the session cards", () => {
    render(2);
    const bar = container.querySelector("[data-testid=move-tracks-bar]") as HTMLElement;
    expect(bar).not.toBeNull();
    const style = getComputedStyle(bar);
    expect(style.position).toBe("sticky");
    expect(style.top).not.toBe("");
    expect(Number(style.zIndex)).toBeGreaterThan(0);
    expect(style.backgroundColor).not.toBe("transparent");
  });

  it("should delete the selected tracks only after the admin confirms", async () => {
    const onBulkDelete = vi.fn();
    render(14, onBulkDelete);
    const button = container.querySelector("[data-testid=delete-selected-tracks]") as HTMLButtonElement;
    act(() => button.click());
    expect(onBulkDelete).not.toHaveBeenCalled();
    const confirm = document.querySelector("[data-testid=confirm-delete-tracks]") as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(onBulkDelete).toHaveBeenCalledTimes(1);
  });

  it("should not offer deletion when no delete handler is given", () => {
    render(3);
    expect(container.querySelector("[data-testid=delete-selected-tracks]")).toBeNull();
  });

  const selectAllButton = () => container.querySelector("[data-testid=select-all-tracks]") as HTMLButtonElement | null;

  it("should offer Select all before any track is ticked, without the sticky bar", () => {
    const onSelectAll = vi.fn();
    render(0, undefined, { totalCount: 8, onSelectAll });
    expect(container.querySelector("[data-testid=move-tracks-bar]")).toBeNull();
    act(() => selectAllButton()!.click());
    expect(onSelectAll).toHaveBeenCalledTimes(1);
  });

  it("should offer Select all while only some tracks are ticked", () => {
    render(3, undefined, { totalCount: 8, onSelectAll: vi.fn() });
    expect(selectAllButton()).not.toBeNull();
  });

  it("should not offer Select all once every track is ticked", () => {
    render(8, undefined, { totalCount: 8, onSelectAll: vi.fn() });
    expect(selectAllButton()).toBeNull();
  });

  it("should not offer Select all when the event has no track", () => {
    render(0, undefined, { totalCount: 0, onSelectAll: vi.fn() });
    expect(selectAllButton()).toBeNull();
  });
});
