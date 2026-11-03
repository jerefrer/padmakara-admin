/**
 * The slide editor dialog: saving keeps it open and confirms in place, closing
 * still guards unsaved changes, and a copied session slide shows its review
 * notice until the admin edits it. The canvas, preview and burn controls are
 * stubbed; they have their own tests.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Slide, SlideDocument } from "@slides/types.ts";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string, options?: { _?: string }) => options?._ ?? key,
  useNotify: () => vi.fn(),
}));
vi.mock("../utils/authFetch", () => ({ authFetch: vi.fn(async () => ({ ok: false })) }));
vi.mock("./SlideBurnStatus", () => ({ BurnActionButton: () => null, BurnStatusChip: () => null }));
vi.mock("./SlideCanvas", () => ({ SlideCanvas: () => null }));
vi.mock("./SlideEditorPreview", () => ({ SlideEditorPreview: () => null }));

import { SlideEditor, type SlideEditorProps } from "./SlideEditor";

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

const slide = (id: string, over: Partial<Slide> = {}): Slide => ({
  id,
  durationMs: 4000,
  fadeMs: 800,
  lines: [{ id: `${id}-l`, type: "text", spans: [{ text: id }], size: "md" }],
  ...over,
});

const docWith = (intro: Slide[]): SlideDocument => ({ version: 1, intro, outro: [] });

const mount = (initialDocument: SlideDocument, props: Partial<SlideEditorProps> = {}) => {
  const handlers = {
    onClose: vi.fn(),
    onSave: vi.fn(async () => true),
  };
  act(() =>
    root.render(
      <SlideEditor
        open
        title="Part 1"
        videoId={1}
        initialDocument={initialDocument}
        onGenerateDefaults={vi.fn(async () => null)}
        copySources={[]}
        onCopyFrom={vi.fn(async () => null)}
        sessions={[]}
        sessionId={null}
        onChangeSession={vi.fn()}
        videoUploaded={false}
        {...handlers}
        {...props}
      />,
    ),
  );
  return handlers;
};

const buttonByText = (text: string): HTMLButtonElement => {
  const el = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!el) throw new Error(`No button with text "${text}"`);
  return el;
};

const flush = () => act(async () => undefined);

/** Make the document dirty by deleting the selected slide. */
const dirtyTheDocument = () => act(() => buttonByText("Delete slide").click());

describe("SlideEditor saving", () => {
  it("should keep Save disabled while nothing changed", () => {
    mount(docWith([slide("a"), slide("b")]));
    expect(buttonByText("Save slides").disabled).toBe(true);
  });

  it("should save without closing the editor and confirm it", async () => {
    const { onSave, onClose } = mount(docWith([slide("a"), slide("b")]));
    dirtyTheDocument();

    await act(async () => buttonByText("Save slides").click());

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Slides saved");
  });

  it("should count the document as clean after a save", async () => {
    mount(docWith([slide("a"), slide("b")]));
    dirtyTheDocument();
    expect(buttonByText("Save slides").disabled).toBe(false);

    await act(async () => buttonByText("Save slides").click());

    expect(buttonByText("Save slides").disabled).toBe(true);
  });

  it("should not confirm, and stay dirty, when the save fails", async () => {
    const { onClose } = mount(docWith([slide("a"), slide("b")]), { onSave: vi.fn(async () => false) });
    dirtyTheDocument();

    await act(async () => buttonByText("Save slides").click());

    expect(document.body.textContent).not.toContain("Slides saved");
    expect(buttonByText("Save slides").disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should close with the X button without asking when everything is saved", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onClose } = mount(docWith([slide("a"), slide("b")]));
    dirtyTheDocument();
    await act(async () => buttonByText("Save slides").click());

    act(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());

    expect(confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it("should still ask before closing with unsaved changes", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onClose } = mount(docWith([slide("a"), slide("b")]));
    dirtyTheDocument();

    act(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

describe("SlideEditor needs-review flag", () => {
  const REVIEW_TEXT = "Copied from another video: check the session number and date.";
  const flaggedDoc = () => docWith([slide("session", { role: "session", needsReview: true })]);

  it("should show the warning icon and the notice for a flagged slide", async () => {
    mount(flaggedDoc());
    await flush();
    expect(document.body.querySelector('[aria-label="Needs review"]')).not.toBeNull();
    expect(document.body.textContent).toContain(REVIEW_TEXT);
  });

  it("should clear the flag when Done is pressed and then allow saving", async () => {
    mount(flaggedDoc());
    act(() => buttonByText("Done").click());

    expect(document.body.querySelector('[aria-label="Needs review"]')).toBeNull();
    expect(document.body.textContent).not.toContain(REVIEW_TEXT);
    expect(buttonByText("Save slides").disabled).toBe(false);
  });

  it("should clear the flag when the slide's timing is edited", () => {
    mount(flaggedDoc());
    const onScreen = document.body.querySelector<HTMLInputElement>('input[type="number"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

    act(() => {
      setValue.call(onScreen, "6");
      onScreen.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(document.body.querySelector('[aria-label="Needs review"]')).toBeNull();
  });
});
