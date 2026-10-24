/**
 * TranslatableField: the AI-review and translate chips sit on the label line,
 * outside the input, so the text keeps the full width of the box.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
  useNotify: () => vi.fn(),
}));

import { TranslatableField, type TranslatableFieldProps } from "./TranslatableField";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const props = (over: Partial<TranslatableFieldProps> = {}): TranslatableFieldProps => ({
  value: "Some text",
  onChange: vi.fn(),
  reviewed: true,
  onMarkReviewed: vi.fn(),
  onTranslate: vi.fn(),
  translatePending: false,
  canTranslate: true,
  direction: "en-to-pt",
  label: "Main Themes (English)",
  translateTooltip: "Translate to Portuguese",
  multiline: true,
  ...over,
});

const render = (p: TranslatableFieldProps) => act(() => root.render(<TranslatableField {...p} />));
const chip = (text: string) =>
  [...container.querySelectorAll<HTMLElement>(".MuiChip-root")].find((c) => c.textContent?.includes(text));

describe("TranslatableField", () => {
  it("should render the translate chip outside the input box", () => {
    render(props());
    const translateChip = chip("EN → PT");
    expect(translateChip).toBeDefined();
    expect(translateChip!.closest(".MuiInputBase-root")).toBeNull();
    expect(container.querySelector(".MuiInputAdornment-root")).toBeNull();
  });

  it("should show the AI review chip outside the input only while the value is unreviewed", () => {
    render(props({ reviewed: false }));
    const review = chip("padmakara.events.aiChipLabel");
    expect(review).toBeDefined();
    expect(review!.closest(".MuiInputBase-root")).toBeNull();

    render(props({ reviewed: true }));
    expect(chip("padmakara.events.aiChipLabel")).toBeUndefined();
  });

  it("should call the handlers when the chips are clicked", () => {
    const p = props({ reviewed: false });
    render(p);
    act(() => chip("EN → PT")!.click());
    act(() => chip("padmakara.events.aiChipLabel")!.click());
    expect(p.onTranslate).toHaveBeenCalledTimes(1);
    expect(p.onMarkReviewed).toHaveBeenCalledTimes(1);
  });

  it("should disable the translate chip when the field cannot be translated", () => {
    render(props({ canTranslate: false }));
    expect(chip("EN → PT")!.classList.contains("Mui-disabled")).toBe(true);
  });

  it("should label the reverse direction PT → EN", () => {
    render(props({ direction: "pt-to-en" }));
    expect(chip("PT → EN")).toBeDefined();
  });
});
