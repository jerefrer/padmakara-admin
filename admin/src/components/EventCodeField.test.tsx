/**
 * EventCodeField: an automatically generated code carries the approve chip
 * until a person confirms or edits it; typed codes survive later auto-fills.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
}));

import { EventCodeField, withAutoEventCode, type EventCodeFieldProps } from "./EventCodeField";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CHIP = "padmakara.events.eventCodeChipLabel";

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

const props = (over: Partial<EventCodeFieldProps> = {}): EventCodeFieldProps => ({
  value: "20260101-PP1",
  reviewed: true,
  onChange: vi.fn(),
  onMarkReviewed: vi.fn(),
  ...over,
});

const render = (p: EventCodeFieldProps) => act(() => root.render(<EventCodeField {...p} />));
const chip = () =>
  [...container.querySelectorAll<HTMLElement>(".MuiChip-root")].find((c) => c.textContent?.includes(CHIP));
const input = () => container.querySelector<HTMLInputElement>("input")!;

describe("EventCodeField", () => {
  it("should show the approve chip when the code is not reviewed", () => {
    render(props({ reviewed: false }));
    expect(chip()).toBeDefined();
  });

  it("should hide the approve chip when the code is reviewed", () => {
    render(props({ reviewed: true }));
    expect(chip()).toBeUndefined();
  });

  it("should call onMarkReviewed when the chip is clicked", () => {
    const p = props({ reviewed: false });
    render(p);
    act(() => chip()!.click());
    expect(p.onMarkReviewed).toHaveBeenCalledTimes(1);
  });

  it("should report typed text through onChange", () => {
    const p = props({ reviewed: false });
    render(p);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input(), "20260101-RP1");
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(p.onChange).toHaveBeenCalledWith("20260101-RP1");
  });

  it("should keep the input read-only and still show the chip when readOnly", () => {
    render(props({ reviewed: false, readOnly: true }));
    expect(input().readOnly).toBe(true);
    expect(chip()).toBeDefined();
  });
});

describe("withAutoEventCode", () => {
  it("should fill an empty code and mark it unreviewed", () => {
    const out = withAutoEventCode({ eventCode: "", eventCodeReviewed: true }, "A-B");
    expect(out).toEqual({ eventCode: "A-B", eventCodeReviewed: false });
  });

  it("should refresh a previous automatic code and keep it unreviewed", () => {
    const out = withAutoEventCode({ eventCode: "A", eventCodeReviewed: false }, "A-B");
    expect(out).toEqual({ eventCode: "A-B", eventCodeReviewed: false });
  });

  it("should not overwrite a code a person typed", () => {
    const form = { eventCode: "RP1", eventCodeReviewed: true };
    expect(withAutoEventCode(form, "A-B")).toBe(form);
  });
});
