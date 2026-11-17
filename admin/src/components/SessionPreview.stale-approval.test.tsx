/**
 * Event 928: AI-written Portuguese titles that Sofia had approved came back
 * pending. The inline track editor saved its whole opening snapshot, approval
 * flags included, so an edit made from a view older than the approval (another
 * admin's open page, or a refresh landing while the editor was open) wrote the
 * old "not reviewed" flag back. The editor now saves only what was changed in it.
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

const TRACK_ID = 9281;

const AI_TRACK = {
  id: TRACK_ID,
  trackNumber: 3,
  title: "Refuge",
  titleEn: "Refuge",
  titlePt: "Refúgio",
  titleEnReviewed: true,
  titlePtReviewed: false,
  languages: ["en"],
  originalLanguage: "en",
  isPractice: false,
  isTranslation: false,
  speaker: "",
  originalFilename: "t.mp3",
  file: { size: 1000, name: "t.mp3" },
};

const sessionWith = (track: Record<string, unknown>): InferredSession =>
  ({
    id: 1,
    sessionNumber: 1,
    titleEn: "Session 1",
    titlePt: "",
    date: "2026-09-14",
    timePeriod: "morning",
    tracks: [track],
  }) as unknown as InferredSession;

let container: HTMLDivElement;
let root: Root;
const onTrackUpdate = vi.fn((_id: number, _updates: Record<string, unknown>) => Promise.resolve());

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

const render = (track: Record<string, unknown>) =>
  act(() => {
    root.render(
      <SessionPreview sessions={[sessionWith(track)]} onSessionTitleChange={() => {}} onTrackUpdate={onTrackUpdate} />,
    );
  });

const openEditor = () => {
  const title = [...container.querySelectorAll("p, span")].find((el) => el.textContent === "Refuge") as HTMLElement;
  act(() => title.click());
};

const clickChip = (label: string) => {
  const chip = [...container.querySelectorAll(".MuiChip-root")].find((el) => el.textContent === label) as HTMLElement;
  act(() => chip.click());
};

const pressEnter = () => {
  const input = container.querySelector('input[placeholder="padmakara.events.titleEn"]') as HTMLInputElement;
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
};

const sentUpdates = () => onTrackUpdate.mock.calls[0]![1];

describe("track editor and approved AI titles", () => {
  it("should not send the approval flags when only another field was edited", () => {
    render(AI_TRACK);
    openEditor();
    clickChip("Practice");
    pressEnter();
    expect(onTrackUpdate).toHaveBeenCalledTimes(1);
    expect(sentUpdates()).toMatchObject({ isPractice: true });
    expect(sentUpdates()).not.toHaveProperty("titlePtReviewed");
    expect(sentUpdates()).not.toHaveProperty("titlePt");
  });

  it("should not undo an approval that arrived while the editor was open", () => {
    render(AI_TRACK);
    openEditor();
    // The approval lands (refresh after a chip click elsewhere, or another admin's save).
    render({ ...AI_TRACK, titlePtReviewed: true });
    clickChip("Practice");
    pressEnter();
    expect(sentUpdates()).not.toHaveProperty("titlePtReviewed");
  });

  it("should send an approval given in the editor", () => {
    render(AI_TRACK);
    openEditor();
    clickChip("padmakara.events.aiChipLabel");
    pressEnter();
    expect(sentUpdates()).toMatchObject({ titlePtReviewed: true });
  });

  it("should save nothing when nothing was changed", () => {
    render(AI_TRACK);
    openEditor();
    render({ ...AI_TRACK, titlePtReviewed: true });
    pressEnter();
    expect(onTrackUpdate).not.toHaveBeenCalled();
  });
});
