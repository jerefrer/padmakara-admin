/** Checkbox multi-select: stays open while picking, ticked = selected, chips follow. */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import TextField from "@mui/material/TextField";
import { CheckboxMultiSelect } from "./CheckboxMultiSelect";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Opt {
  id: number;
  label: string;
}
const OPTIONS: Opt[] = [
  { id: 1, label: "Alpha" },
  { id: 2, label: "Beta" },
  { id: 3, label: "Gamma" },
];

const Harness = () => {
  const [value, setValue] = useState<Opt[]>([]);
  return (
    <CheckboxMultiSelect<Opt>
      options={OPTIONS}
      value={value}
      onChange={(_, v) => setValue(v)}
      getOptionLabel={(o) => o.label}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      renderInput={(params) => <TextField {...params} label="Groups" />}
    />
  );
};

const options = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
const chips = (host: HTMLElement): string[] =>
  [...host.querySelectorAll(".MuiChip-label")].map((c) => c.textContent ?? "");
const ticked = (el: HTMLElement): boolean =>
  (el.querySelector('input[type="checkbox"]') as HTMLInputElement).checked;
const optionNamed = (label: string): HTMLElement => {
  const found = options().find((o) => o.textContent === label);
  if (!found) throw new Error(`no option ${label}`);
  return found;
};

describe("CheckboxMultiSelect", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
    const input = host.querySelector("input") as HTMLInputElement;
    act(() => {
      input.focus();
      input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("should keep the list open and show the option ticked when picking one", () => {
    act(() => optionNamed("Alpha").click());

    expect(options()).toHaveLength(3);
    expect(ticked(optionNamed("Alpha"))).toBe(true);
    expect(ticked(optionNamed("Beta"))).toBe(false);
  });

  it("should add both chips when picking two options in a row", () => {
    act(() => optionNamed("Alpha").click());
    act(() => optionNamed("Gamma").click());

    expect(chips(host)).toEqual(["Alpha", "Gamma"]);
  });

  it("should remove the chip and the tick when unticking an option", () => {
    act(() => optionNamed("Alpha").click());
    act(() => optionNamed("Beta").click());
    act(() => optionNamed("Alpha").click());

    expect(chips(host)).toEqual(["Beta"]);
    expect(ticked(optionNamed("Alpha"))).toBe(false);
  });

  it("should close the list on Escape", () => {
    const input = host.querySelector("input") as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(options()).toHaveLength(0);
  });
});
