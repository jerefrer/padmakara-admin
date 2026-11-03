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

function render(selectedCount: number) {
  act(() => {
    root.render(
      <MoveTracksBar
        sessions={[]}
        selectedCount={selectedCount}
        busy={false}
        defaultDate="2026-04-12"
        onMove={() => {}}
        onClear={() => {}}
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
});
