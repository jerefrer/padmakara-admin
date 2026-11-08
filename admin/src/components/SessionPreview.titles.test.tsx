/**
 * André: clicking a Portuguese track's title opened an "EN" line holding the
 * same Portuguese text. A Portuguese track now edits one title, and the copy
 * in the English field goes away on save so the app serves the edited one.
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

const TRACK_ID = 101;

const sessionWith = (track: Record<string, unknown>): InferredSession =>
  ({
    id: 1,
    sessionNumber: 1,
    titleEn: "Session 1",
    titlePt: "",
    date: "2026-10-10",
    timePeriod: "morning",
    tracks: [
      {
        id: TRACK_ID,
        trackNumber: 2,
        title: track.titleEn,
        originalFilename: "t.mp3",
        file: { size: 1000, name: "t.mp3" },
        isTranslation: true,
        ...track,
      },
    ],
  }) as unknown as InferredSession;

let container: HTMLDivElement;
let root: Root;
const onTrackUpdate = vi.fn(() => Promise.resolve());

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

function openEditor(track: Record<string, unknown>, shownTitle: string) {
  act(() => {
    root.render(
      <SessionPreview
        sessions={[sessionWith(track)]}
        onSessionTitleChange={() => {}}
        onTrackUpdate={onTrackUpdate}
      />,
    );
  });
  const title = [...container.querySelectorAll("p, span")].find((el) => el.textContent === shownTitle) as HTMLElement;
  act(() => title.click());
}

const input = (field: "En" | "Pt") =>
  container.querySelector(`input[placeholder="padmakara.events.title${field}"]`) as HTMLInputElement | null;

const typeAndSave = (el: HTMLInputElement, text: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
};

const PT_TWIN = {
  languages: ["pt"],
  originalLanguage: "pt",
  titleEn: "Aprender a Desapegar-se - Manha Parte 2",
  titlePt: "Aprender a Desapegar-se - Manhã Parte 2",
};

describe("track title editor", () => {
  it("should hide the English line for a Portuguese track holding the same title twice", () => {
    openEditor(PT_TWIN, PT_TWIN.titlePt);
    expect(input("En")).toBeNull();
    expect(input("Pt")!.value).toBe(PT_TWIN.titlePt);
  });

  it("should empty the English copy when a Portuguese title is saved", () => {
    openEditor(PT_TWIN, PT_TWIN.titlePt);
    typeAndSave(input("Pt")!, "Aprender a Desapegar-se");
    expect(onTrackUpdate).toHaveBeenCalledWith(
      TRACK_ID,
      expect.objectContaining({ titlePt: "Aprender a Desapegar-se", titleEn: "", titleEnReviewed: true }),
    );
  });

  it("should show the only title in the Portuguese line when it sits in the English field", () => {
    openEditor({ languages: ["pt"], originalLanguage: "pt", titleEn: "Aprender", titlePt: "" }, "Aprender");
    expect(input("En")).toBeNull();
    expect(input("Pt")!.value).toBe("Aprender");
  });

  it("should keep the English line when it holds a real translation", () => {
    openEditor({ languages: ["pt"], originalLanguage: "pt", isTranslation: false, titleEn: "Learning to Let Go", titlePt: "Aprender" }, "Learning to Let Go");
    expect(input("En")!.value).toBe("Learning to Let Go");
  });

  it("should show one Portuguese line on a translation track, even with an English title saved", () => {
    openEditor(
      { languages: ["pt"], originalLanguage: "pt", isTranslation: true, titleEn: "The role", titlePt: "O papel" },
      "O papel",
    );
    expect(input("En")).toBeNull();
    expect(input("Pt")!.value).toBe("O papel");
  });

  it("should empty the English title when a translation track is saved", () => {
    openEditor(
      { languages: ["pt"], originalLanguage: "pt", isTranslation: true, titleEn: "The role", titlePt: "O papel" },
      "O papel",
    );
    typeAndSave(input("Pt")!, "O papel do mestre");
    expect(onTrackUpdate).toHaveBeenCalledWith(
      TRACK_ID,
      expect.objectContaining({ titlePt: "O papel do mestre", titleEn: "", titleEnReviewed: true }),
    );
  });

  it("should keep both lines for an English track", () => {
    openEditor({ languages: ["en"], originalLanguage: "en", titleEn: "Learning", titlePt: "" }, "Learning");
    expect(input("En")).not.toBeNull();
    expect(input("Pt")).not.toBeNull();
  });

  it("should open the editor on the Portuguese title when its line is clicked", () => {
    openEditor(
      { languages: ["en"], originalLanguage: "en", isTranslation: false, titleEn: "Arising deities", titlePt: "Emergir das deidades" },
      "Emergir das deidades",
    );
    expect(input("Pt")).not.toBeNull();
    expect(document.activeElement).toBe(input("Pt"));
  });

  it("should still focus the English title when the English line is clicked", () => {
    openEditor(
      { languages: ["en"], originalLanguage: "en", isTranslation: false, titleEn: "Arising deities", titlePt: "Emergir das deidades" },
      "Arising deities",
    );
    expect(document.activeElement).toBe(input("En"));
  });
});
