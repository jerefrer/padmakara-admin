/**
 * The post-upload reconciliation warning: lists the tracks still without
 * audio and offers the resume path. Mounted with react-dom directly, like the
 * other component tests here (no @testing-library in this project).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Echo keys and their interpolation so assertions can read them.
vi.mock("react-admin", () => ({
  useTranslate: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key} ${JSON.stringify(opts)}` : key,
}));

import { UploadIncompleteAlert } from "./UploadIncompleteAlert";
import type { MissingAudioTrack } from "../utils/audioResume";

// React 19 only flushes act() updates when this flag is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const track = (id: number): MissingAudioTrack => ({
  id,
  sessionId: 1,
  sessionNumber: 2,
  trackNumber: id,
  title: `Talk ${id}`,
  originalFilename: `00${id} Talk.mp3`,
  fileSizeBytes: null,
});

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

describe("UploadIncompleteAlert", () => {
  it("should list every track left without audio", () => {
    act(() => root.render(<UploadIncompleteAlert tracks={[track(1), track(2)]} onResume={() => {}} />));

    const items = Array.from(container.querySelectorAll("li")).map((li) => li.textContent);
    expect(items).toEqual(["S2 · 1. Talk 1001 Talk.mp3", "S2 · 2. Talk 2002 Talk.mp3"]);
    expect(container.textContent).toContain('padmakara.events.uploadIncompleteTitle {"smart_count":2}');
  });

  it("should summarise tracks beyond the first twelve", () => {
    const many = Array.from({ length: 15 }, (_, i) => track(i + 1));

    act(() => root.render(<UploadIncompleteAlert tracks={many} onResume={() => {}} />));

    expect(container.querySelectorAll("li")).toHaveLength(12);
    expect(container.textContent).toContain('padmakara.events.uploadIncompleteMore {"smart_count":3}');
  });

  it("should offer the resume path", () => {
    const onResume = vi.fn();
    act(() => root.render(<UploadIncompleteAlert tracks={[track(1)]} onResume={onResume} />));

    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "padmakara.events.resumeUpload",
    );
    act(() => button!.click());

    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
