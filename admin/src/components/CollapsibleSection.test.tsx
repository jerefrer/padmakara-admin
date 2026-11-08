/** Collapsible card and the shared open/closed state behind it. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollapsibleSection, useCollapsibleSections } from "./CollapsibleSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IDS = ["a", "b"] as const;

function Harness() {
  const s = useCollapsibleSections(IDS, { a: true, b: false });
  return (
    <div>
      <button data-testid="all" onClick={() => s.setAll(!s.allOpen)}>
        {s.allOpen ? "Collapse all" : "Expand all"}
      </button>
      {IDS.map((id) => (
        <CollapsibleSection
          key={id}
          id={id}
          title={`Title ${id}`}
          summary={`Summary ${id}`}
          badge={id === "b" ? "No tracks" : null}
          action={id === "b" ? <input type="checkbox" aria-label="Show in app" data-testid="action" /> : undefined}
          open={s.open[id]!}
          onToggle={() => s.toggle(id)}
        >
          <p>Body {id}</p>
        </CollapsibleSection>
      ))}
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

const header = (id: string) => container.querySelector(`#${id}-header`) as HTMLButtonElement;
const mount = () => act(() => root.render(<Harness />));

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CollapsibleSection", () => {
  it("should apply the default open state through aria-expanded", () => {
    mount();
    expect(header("a").getAttribute("aria-expanded")).toBe("true");
    expect(header("b").getAttribute("aria-expanded")).toBe("false");
  });

  it("should render the header as a button that always shows title, summary and badge", () => {
    mount();
    expect(header("b").tagName).toBe("BUTTON");
    expect(header("b").textContent).toContain("Title b");
    expect(header("b").textContent).toContain("Summary b");
    expect(header("b").textContent).toContain("No tracks");
    expect(header("a").textContent).not.toContain("No tracks");
  });

  it("should toggle one section when its header is clicked", () => {
    mount();
    act(() => header("b").click());
    expect(header("b").getAttribute("aria-expanded")).toBe("true");
    act(() => header("b").click());
    expect(header("b").getAttribute("aria-expanded")).toBe("false");
  });

  it("should keep the body mounted while closed", () => {
    mount();
    expect(container.textContent).toContain("Body b");
  });

  it("should expand all then collapse all", () => {
    mount();
    const all = container.querySelector('[data-testid="all"]') as HTMLButtonElement;
    expect(all.textContent).toBe("Expand all");
    act(() => all.click());
    expect(header("a").getAttribute("aria-expanded")).toBe("true");
    expect(header("b").getAttribute("aria-expanded")).toBe("true");
    expect(all.textContent).toBe("Collapse all");
    act(() => all.click());
    expect(header("a").getAttribute("aria-expanded")).toBe("false");
    expect(header("b").getAttribute("aria-expanded")).toBe("false");
  });

  it("should open with the defaults every time, not with what was open last time", () => {
    mount();
    act(() => header("b").click());
    expect(header("b").getAttribute("aria-expanded")).toBe("true");
    act(() => root.unmount());
    root = createRoot(container);
    mount();
    expect(header("b").getAttribute("aria-expanded")).toBe("false");
  });

  describe("header action", () => {
    const action = () => container.querySelector('[data-testid="action"]') as HTMLInputElement;

    it("should show the action in the header while the section is closed", () => {
      mount();
      expect(header("b").getAttribute("aria-expanded")).toBe("false");
      expect(action()).not.toBeNull();
      expect(container.querySelector('[data-section="b"]')!.contains(action())).toBe(true);
    });

    it("should not fold or unfold the section when the action is used", () => {
      mount();
      act(() => action().click());
      expect(header("b").getAttribute("aria-expanded")).toBe("false");
      act(() => header("b").click());
      act(() => action().click());
      expect(header("b").getAttribute("aria-expanded")).toBe("true");
    });

    it("should keep the action outside the header button", () => {
      mount();
      expect(header("b").contains(action())).toBe(false);
      expect(action().closest("button")).toBeNull();
    });

    it("should render nothing extra when there is no action", () => {
      mount();
      expect(container.querySelector('[data-section-action="a"]')).toBeNull();
    });
  });
});
