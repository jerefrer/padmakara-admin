/**
 * The slide editor's sequence column and line toolbar: what selecting a slide
 * and pressing a formatting button does. The canvas itself edits inside an
 * iframe and is covered through its pure helpers (utils/slideCanvas.test.ts).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeClipSlide, type Slide, type TextLine } from "@slides/types.ts";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string, options?: { _?: string }) => options?._ ?? key,
}));
vi.mock("./SlideBurnStatus", () => ({
  BurnActionButton: () => null,
  BurnStatusChip: () => null,
}));

import { SlideLineToolbar } from "./SlideLineToolbar";
import { SlideSequenceList } from "./SlideSequenceList";

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

const textSlide = (id: string, text: string, over: Partial<Slide> = {}): Slide => ({
  id,
  durationMs: 4000,
  fadeMs: 800,
  lines: [{ id: `${id}-l`, type: "text", spans: [{ text }], size: "md" }],
  ...over,
});

const button = (label: string): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!el) throw new Error(`No button labelled "${label}"`);
  return el;
};

describe("SlideSequenceList", () => {
  const intro = [
    makeClipSlide("clip", "padmakara-logo-intro"),
    textSlide("a", "Speaker", { role: "speaker" }),
    textSlide("b", "A hand-made slide"),
  ];
  const outro = [textSlide("o", "Thanks")];

  const mount = (selectedId: string | null, onSelect = vi.fn(), onAdd = vi.fn()) =>
    act(() =>
      root.render(
        <SlideSequenceList
          intro={intro}
          outro={outro}
          selection={{ sequence: "intro", slideId: selectedId }}
          resolveImageUrl={(k) => k}
          onSelect={onSelect}
          onAdd={onAdd}
          video={{
            state: "notUploaded",
            burnStatus: "none",
            burnError: null,
            burnDisk: null,
            hasMaster: false,
            slideCount: 4,
            reburning: false,
            onReburn: () => undefined,
          }}
        />,
      ),
    );

  const rows = () => Array.from(container.querySelectorAll<HTMLButtonElement>("li button"));

  it("should show one row per slide with its label and length", () => {
    mount("a");
    const labels = rows().map((r) => r.textContent);
    expect(labels).toEqual([
      "Padmakara logo animation8.0 s",
      "Speaker5.6 s",
      "A hand-made slide5.6 s",
      "Thanks5.6 s",
    ]);
  });

  it("should total the intro as m:ss in its heading", () => {
    mount("a");
    // 8 s clip + 5.6 s + 5.6 s = 19.2 s
    expect(container.querySelector('section[aria-label="INTRO"]')!.textContent).toContain("0:19");
  });

  it("should mark only the selected slide as current", () => {
    mount("b");
    expect(rows().map((r) => r.getAttribute("aria-current"))).toEqual([null, null, "true", null]);
  });

  it("should report the clicked slide with its sequence", () => {
    const onSelect = vi.fn();
    mount("a", onSelect);
    act(() => rows()[3]!.click());
    expect(onSelect).toHaveBeenCalledWith("outro", "o");
  });

  it("should show the video block as not uploaded", () => {
    mount("a");
    expect(container.textContent).toContain("Not uploaded yet");
  });

  it("should ask to add a slide to the intro and to the outro", () => {
    const onAdd = vi.fn();
    mount("a", vi.fn(), onAdd);
    const add = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
      (b) => b.textContent === "Add slide",
    );
    act(() => add[0]!.click());
    act(() => add[1]!.click());
    expect(onAdd.mock.calls).toEqual([["intro"], ["outro"]]);
  });
});

describe("SlideLineToolbar", () => {
  const line: TextLine = { id: "l", type: "text", spans: [{ text: "x" }], size: "md", smallCaps: true };

  const mount = (props: Partial<React.ComponentProps<typeof SlideLineToolbar>> = {}) => {
    const handlers = {
      onSize: vi.fn(),
      onMark: vi.fn(),
      onToggleSmallCaps: vi.fn(),
      onToggleDim: vi.fn(),
      onDelete: vi.fn(),
    };
    act(() =>
      root.render(<SlideLineToolbar line={line} marks={{ bold: false, italic: true }} {...handlers} {...props} />),
    );
    return handlers;
  };

  it("should show the toggles as pressed for the selected line", () => {
    mount();
    expect(button("Small caps").getAttribute("aria-pressed")).toBe("true");
    expect(button("Dim").getAttribute("aria-pressed")).toBe("false");
    expect(button("Italic").getAttribute("aria-pressed")).toBe("true");
    expect(button("Bold").getAttribute("aria-pressed")).toBe("false");
  });

  it("should toggle small caps and dim, mark bold and delete the line", () => {
    const h = mount();
    act(() => button("Small caps").click());
    act(() => button("Dim").click());
    act(() => button("Bold").click());
    act(() => button("Delete line").click());
    expect(h.onToggleSmallCaps).toHaveBeenCalledTimes(1);
    expect(h.onToggleDim).toHaveBeenCalledTimes(1);
    expect(h.onMark).toHaveBeenCalledWith("bold");
    expect(h.onDelete).toHaveBeenCalledTimes(1);
  });

  it("should offer only delete for an image or space line", () => {
    mount({ line: { id: "s", type: "spacer" } });
    expect(container.querySelector('button[aria-label="Bold"]')).toBeNull();
    expect(button("Delete line").disabled).toBe(false);
  });

  it("should disable delete and prompt for a selection when no line is selected", () => {
    mount({ line: null });
    expect(button("Delete line").disabled).toBe(true);
    expect(container.textContent).toContain("Select a line on the slide");
  });
});
