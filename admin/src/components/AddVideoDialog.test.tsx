/**
 * "Add video" dialog: exactly two choices. "Prepare slides" hands a title and
 * a session to onPrepare (no file); "Upload a finished video" keeps the
 * straight-to-Bunny path and pre-selects the session from the file name.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
}));

import { AddVideoDialog } from "./AddVideoDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSIONS = [
  { id: 11, sessionNumber: 1, date: "2026-10-10", timePeriod: "morning" },
  { id: 12, sessionNumber: 2, date: "2026-10-10", timePeriod: "evening" },
];

let container: HTMLDivElement;
let root: Root;
const onUpload = vi.fn();
const onImportUrl = vi.fn(async () => {});
const onPrepare = vi.fn(async () => {});

beforeEach(() => {
  onUpload.mockClear();
  onImportUrl.mockClear();
  onPrepare.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <AddVideoDialog
        open
        onClose={() => {}}
        sessions={SESSIONS}
        onPrepare={onPrepare}
        onUpload={onUpload}
        onImportUrl={onImportUrl}
      />,
    );
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

const submitButton = (label: string) => byText(label).closest("button") as HTMLButtonElement;

const pickFile = (name: string) => {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["x"], name, { type: "video/mp4" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return file;
};

const typeTitle = (value: string) => {
  const input = document.body.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("AddVideoDialog choices", () => {
  it("should offer exactly the two choices", () => {
    expect(byText("padmakara.videos.addDialog.cardPrepareTitle")).toBeTruthy();
    expect(byText("padmakara.videos.addDialog.cardFinishedTitle")).toBeTruthy();
    expect(document.body.textContent).not.toContain("cardDefineTitle");
    expect(document.body.textContent).not.toContain("cardLaterTitle");
    expect(document.body.textContent).not.toContain("cardBurnedTitle");
  });

  it("should keep the submit button disabled until a choice is made", () => {
    expect(submitButton("padmakara.videos.addDialog.uploadAction").disabled).toBe(true);
  });
});

describe("Prepare slides", () => {
  it("should need a title before it can be submitted", () => {
    click(byText("padmakara.videos.addDialog.cardPrepareTitle"));
    expect(submitButton("padmakara.videos.addDialog.prepareAction").disabled).toBe(true);
    typeTitle("Day 1 morning");
    expect(submitButton("padmakara.videos.addDialog.prepareAction").disabled).toBe(false);
  });

  it("should call onPrepare with the title and no file", async () => {
    click(byText("padmakara.videos.addDialog.cardPrepareTitle"));
    typeTitle("Day 1 morning");
    await act(async () => submitButton("padmakara.videos.addDialog.prepareAction").click());
    expect(onPrepare).toHaveBeenCalledWith({ title: "Day 1 morning", sessionId: null });
    expect(onUpload).not.toHaveBeenCalled();
  });
});

describe("Upload a finished video", () => {
  it("should send null slides, the burnt-in flag and no session for a file without a date", () => {
    click(byText("padmakara.videos.addDialog.cardFinishedTitle"));
    const file = pickFile("talk.mp4");
    click(submitButton("padmakara.videos.addDialog.uploadAction"));
    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onUpload.mock.calls[0]![0]).toBe(file);
    expect(onUpload.mock.calls[0]![1]).toEqual({ slides: null, hasBurnedSlides: true, sessionId: null });
  });

  it("should pre-select the session named by the file's date and period", () => {
    click(byText("padmakara.videos.addDialog.cardFinishedTitle"));
    pickFile("JKR-Lx-2026-10-10-PM.mp4");
    click(submitButton("padmakara.videos.addDialog.uploadAction"));
    expect(onUpload.mock.calls[0]![1]).toEqual({ slides: null, hasBurnedSlides: true, sessionId: 12 });
  });
});
