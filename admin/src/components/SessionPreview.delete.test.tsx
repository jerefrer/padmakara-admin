/**
 * After André deleted every track of an event, its sessions stayed behind
 * with "0 tracks" and no way to remove them. An empty session now has a
 * trash button behind an in-app confirmation that names any linked video.
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

const session = (id: number, number: number, trackCount: number): InferredSession =>
  ({
    id,
    sessionNumber: number,
    titleEn: `Session ${number}`,
    titlePt: "",
    date: "2026-10-10",
    timePeriod: "morning",
    tracks: Array.from({ length: trackCount }, (_, i) => ({
      id: id * 100 + i,
      trackNumber: i + 1,
      title: `Track ${i + 1}`,
      originalFilename: `t${i}.mp3`,
      file: { size: 1000, name: `t${i}.mp3` },
      languages: ["en"],
      originalLanguage: "en",
      isTranslation: false,
    })),
  }) as unknown as InferredSession;

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

function render(
  sessions: InferredSession[],
  onSessionDelete?: (sessionId: number) => Promise<void>,
  videoCountBySession?: ReadonlyMap<number, number>,
) {
  act(() => {
    root.render(
      <SessionPreview
        sessions={sessions}
        onSessionTitleChange={() => {}}
        onSessionDelete={onSessionDelete}
        videoCountBySession={videoCountBySession}
      />,
    );
  });
}

const trashButtons = () => container.querySelectorAll("[data-testid=delete-session]");

describe("SessionPreview empty-session delete", () => {
  it("should offer delete only on sessions without tracks", () => {
    render([session(1, 1, 0), session(2, 2, 3)], vi.fn());
    expect(trashButtons()).toHaveLength(1);
  });

  it("should not offer delete when no delete handler is given", () => {
    render([session(1, 1, 0)]);
    expect(trashButtons()).toHaveLength(0);
  });

  it("should delete the session only after the admin confirms", async () => {
    const onSessionDelete = vi.fn(() => Promise.resolve());
    render([session(5, 1, 0)], onSessionDelete);
    act(() => (trashButtons()[0] as HTMLButtonElement).click());
    expect(onSessionDelete).not.toHaveBeenCalled();
    const confirm = document.querySelector("[data-testid=confirm-delete-session]") as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(onSessionDelete).toHaveBeenCalledWith(5);
  });

  it("should warn that linked videos lose their session", () => {
    render([session(5, 1, 0)], vi.fn(), new Map([[5, 2]]));
    act(() => (trashButtons()[0] as HTMLButtonElement).click());
    expect(document.body.textContent).toContain("padmakara.session.deleteVideoWarning");
  });

  it("should not warn about videos when none is linked", () => {
    render([session(5, 1, 0)], vi.fn(), new Map([[6, 1]]));
    act(() => (trashButtons()[0] as HTMLButtonElement).click());
    expect(document.body.textContent).not.toContain("padmakara.session.deleteVideoWarning");
  });
});
