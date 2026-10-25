/**
 * "Add video" dialog: the three Section-1 choices and what each hands to the
 * parent. "Add slides later" must take the burn path (a slide document, not
 * the burnt-in declaration) with an EMPTY document, without defining slides.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
}));
vi.mock("./SlideEditor", () => ({ SlideEditor: () => null }));

import { AddVideoDialog } from "./AddVideoDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onUpload = vi.fn();
const onImportUrl = vi.fn(async () => {});

beforeEach(() => {
  onUpload.mockClear();
  onImportUrl.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<AddVideoDialog open onClose={() => {}} onUpload={onUpload} onImportUrl={onImportUrl} />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byText = (text: string): HTMLElement => {
  const el = Array.from(document.body.querySelectorAll<HTMLElement>("*")).find(
    (e) => e.textContent === text && !Array.from(e.children).some((c) => c.textContent === text),
  );
  if (!el) throw new Error(`No element with text "${text}"`);
  return el;
};

const click = (el: HTMLElement) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

const uploadButton = () =>
  byText("padmakara.videos.addDialog.uploadAction").closest("button") as HTMLButtonElement;

const pickFile = () => {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["x"], "talk.mp4", { type: "video/mp4" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return file;
};

describe("AddVideoDialog slide choices", () => {
  it("should render the add-slides-later card next to the other two", () => {
    expect(byText("padmakara.videos.addDialog.cardDefineTitle")).toBeTruthy();
    expect(byText("padmakara.videos.addDialog.cardLaterTitle")).toBeTruthy();
    expect(byText("padmakara.videos.addDialog.cardBurnedTitle")).toBeTruthy();
  });

  it("should keep upload disabled until a card is chosen", () => {
    expect(uploadButton().disabled).toBe(true);
  });

  it("should enable upload for a file without defining slides when add-slides-later is chosen", () => {
    click(byText("padmakara.videos.addDialog.cardLaterTitle"));
    pickFile();
    expect(uploadButton().disabled).toBe(false);
  });

  it("should not show the define-slides button when add-slides-later is chosen", () => {
    click(byText("padmakara.videos.addDialog.cardLaterTitle"));
    expect(document.body.textContent).not.toContain("padmakara.slides.gate.defineButton");
  });

  it("should submit the file with an empty slide document and no burnt-in flag", () => {
    click(byText("padmakara.videos.addDialog.cardLaterTitle"));
    const file = pickFile();
    click(uploadButton());
    expect(onUpload).toHaveBeenCalledTimes(1);
    const [sentFile, pending] = onUpload.mock.calls[0]!;
    expect(sentFile).toBe(file);
    expect(pending.hasBurnedSlides).toBe(false);
    expect(pending.slides).toEqual({ version: expect.any(Number), intro: [], outro: [] });
  });

  it("should still send null slides and the burnt-in flag for the burnt-in card", () => {
    click(byText("padmakara.videos.addDialog.cardBurnedTitle"));
    pickFile();
    click(uploadButton());
    expect(onUpload.mock.calls[0]![1]).toEqual({ slides: null, hasBurnedSlides: true });
  });
});
