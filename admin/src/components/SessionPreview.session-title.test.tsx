/**
 * The session title editor saved its whole opening copy (both titles and both
 * approval flags) and decided whether to save by comparing it with the live
 * session. A title changed while the editor was open (another admin's save, or
 * the refresh after an AI apply) therefore looked like an edit, and the save
 * wrote the editor's older text back over it. It now saves only what was
 * changed in it, like the track editor.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/authFetch", () => ({ authFetch: vi.fn() }));
vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
  useNotify: () => vi.fn(),
}));

import { SessionPreview } from "./SessionPreview";
import type { InferredSession } from "../utils/trackParser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = {
  id: 31,
  sessionNumber: 1,
  titleEn: "Day 1",
  titlePt: "Dia 1",
  titleEnReviewed: true,
  titlePtReviewed: false,
  date: "2026-09-14",
  timePeriod: "morning",
  tracks: [],
} as unknown as InferredSession;

let container: HTMLDivElement;
let root: Root;
const onSessionTitleChange = vi.fn((_idx: number, _patch: Partial<InferredSession>) => {});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const render = (session: InferredSession) =>
  act(() => {
    root.render(<SessionPreview sessions={[session]} onSessionTitleChange={onSessionTitleChange} />);
  });

const openEditor = () => {
  const title = [...container.querySelectorAll("p")].find((el) => el.textContent === "Day 1") as HTMLElement;
  act(() => title.click());
};

const englishInput = () =>
  container.querySelector('input[placeholder="padmakara.events.titleEn"]') as HTMLInputElement;

const type = (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const pressEnter = () => {
  act(() => {
    englishInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
};

const sentPatch = () => onSessionTitleChange.mock.calls[0]![1];

describe("session title editor and changes made elsewhere", () => {
  it("should send only the English title when only the English title was edited", () => {
    render(SESSION);
    openEditor();
    type(englishInput(), "Day one");
    pressEnter();
    expect(onSessionTitleChange).toHaveBeenCalledTimes(1);
    expect(sentPatch()).toEqual({ titleEn: "Day one" });
  });

  it("should not write back a Portuguese title changed while the editor was open", () => {
    render(SESSION);
    openEditor();
    // Another admin's save (or the refresh after an AI apply) lands.
    render({ ...SESSION, titlePt: "Primeiro dia", titlePtReviewed: true } as InferredSession);
    type(englishInput(), "Day one");
    pressEnter();
    expect(sentPatch()).not.toHaveProperty("titlePt");
    expect(sentPatch()).not.toHaveProperty("titlePtReviewed");
  });

  it("should save nothing when nothing was changed in the editor", () => {
    render(SESSION);
    openEditor();
    render({ ...SESSION, titlePt: "Primeiro dia", titlePtReviewed: true } as InferredSession);
    pressEnter();
    expect(onSessionTitleChange).not.toHaveBeenCalled();
  });

  it("should send an approval given in the editor", () => {
    render(SESSION);
    openEditor();
    const chip = [...container.querySelectorAll(".MuiChip-root")].find(
      (el) => el.textContent === "padmakara.events.aiChipLabel",
    ) as HTMLElement;
    act(() => chip.click());
    pressEnter();
    expect(sentPatch()).toEqual({ titlePtReviewed: true });
  });
});
