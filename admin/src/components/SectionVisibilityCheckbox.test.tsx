import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({ useTranslate: () => (key: string) => key }));

import { SectionVisibilityCheckbox } from "./SectionVisibilityCheckbox";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SectionVisibilityCheckbox", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const input = () => host.querySelector("input") as HTMLInputElement;

  it("should be ticked when visible and report the flag unticked when clicked", () => {
    const onChange = vi.fn();
    act(() => root.render(<SectionVisibilityCheckbox flag="textsPublished" label="Show" visible onChange={onChange} />));
    expect(input().checked).toBe(true);
    act(() => input().click());
    expect(onChange).toHaveBeenCalledWith("textsPublished", false);
  });

  it("should describe the state in its accessible name", () => {
    act(() => root.render(<SectionVisibilityCheckbox flag="textsPublished" label="Show" visible={false} onChange={() => {}} />));
    expect(input().checked).toBe(false);
    expect(input().getAttribute("aria-label")).toContain("padmakara.events.mediaHidden");
  });
});
