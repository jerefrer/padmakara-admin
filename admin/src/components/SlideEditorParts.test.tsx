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

import { SlideInspector } from "./SlideInspector";
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

describe("needs-review flag", () => {
  const REVIEW_TEXT = "Copied from another video: check the session number and date.";

  const mountList = (intro: Slide[]) =>
    act(() =>
      root.render(
        <SlideSequenceList
          intro={intro}
          outro={[]}
          selection={{ sequence: "intro", slideId: null }}
          resolveImageUrl={(k) => k}
          onSelect={vi.fn()}
          onAdd={vi.fn()}
          video={{
            state: "notUploaded",
            burnStatus: "none",
            burnError: null,
            burnDisk: null,
            hasMaster: false,
            slideCount: intro.length,
            reburning: false,
            onReburn: () => undefined,
          }}
        />,
      ),
    );

  const mountInspector = (slide: Slide, onMarkReviewed = vi.fn()) => {
    act(() =>
      root.render(
        <SlideInspector
          slide={slide}
          onTiming={vi.fn()}
          onSubtitle={vi.fn()}
          onMove={vi.fn()}
          canMoveUp={false}
          canMoveDown={false}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
          onMarkReviewed={onMarkReviewed}
        />,
      ),
    );
    return onMarkReviewed;
  };

  it("should show a warning icon on a flagged slide's card only", () => {
    mountList([textSlide("a", "Session 1 of 4", { needsReview: true }), textSlide("b", "Other")]);
    const cards = Array.from(container.querySelectorAll("li"));
    expect(cards[0]!.querySelector('[aria-label="Needs review"]')).not.toBeNull();
    expect(cards[1]!.querySelector('[aria-label="Needs review"]')).toBeNull();
  });

  it("should show the review notice at the top of the inspector for a flagged slide", () => {
    mountInspector(textSlide("a", "Session 1 of 4", { needsReview: true }));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(REVIEW_TEXT);
  });

  it("should not show the notice for an ordinary slide", () => {
    mountInspector(textSlide("a", "Speaker"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("should ask to clear the flag when Done is pressed", () => {
    const onMarkReviewed = mountInspector(textSlide("a", "Session 1 of 4", { needsReview: true }));
    const done = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Done");
    act(() => done!.click());
    expect(onMarkReviewed).toHaveBeenCalledTimes(1);
  });
});

describe("video block upload progress", () => {
  const mountList = (upload: React.ComponentProps<typeof SlideSequenceList>["video"]["upload"], onCancelUpload = vi.fn()) => {
    act(() =>
      root.render(
        <SlideSequenceList
          intro={[]}
          outro={[]}
          selection={{ sequence: "intro", slideId: null }}
          resolveImageUrl={(k) => k}
          onSelect={vi.fn()}
          onAdd={vi.fn()}
          video={{
            state: "notUploaded",
            upload,
            onCancelUpload,
            burnStatus: "none",
            burnError: null,
            burnDisk: null,
            hasMaster: false,
            slideCount: 0,
            reburning: false,
            onReburn: () => undefined,
            onUploadVideo: () => undefined,
          }}
        />,
      ),
    );
    return onCancelUpload;
  };

  it("should show a progress bar, the percentage and Cancel while uploading", () => {
    const onCancelUpload = mountList({ phase: "uploading", fraction: 0.42 });
    expect(container.textContent).toContain("Uploading… 42%");
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("42");
    expect(container.textContent).not.toContain("Not uploaded yet");
    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Cancel");
    act(() => cancel!.click());
    expect(onCancelUpload).toHaveBeenCalledTimes(1);
  });

  it("should say the video is uploaded and burning once the upload is done", () => {
    mountList({ phase: "done", fraction: 1 });
    expect(container.textContent).toContain("Uploaded, burning…");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("should show the failure and keep the upload button when the upload failed", () => {
    mountList({ phase: "error", fraction: 0.3, error: "network down" });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("network down");
    expect(container.textContent).toContain("Upload video");
  });

  it("should show the usual not-uploaded state when no upload is running", () => {
    mountList(null);
    expect(container.textContent).toContain("Not uploaded yet");
  });
});
