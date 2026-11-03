/**
 * Video rows: the Portuguese title line and the AI-review chip persist the
 * reviewed flag through the existing PATCH route.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
  useNotify: () => vi.fn(),
}));

const authFetch = vi.fn(async () => ({ ok: true, text: async () => "" }));
vi.mock("../utils/authFetch", () => ({ authFetch: (...a: unknown[]) => (authFetch as any)(...a) }));

vi.mock("./AddVideoDialog", () => ({ AddVideoDialog: () => null }));
vi.mock("./MediaPreviewDialog", () => ({ MediaPreviewDialog: () => null }));
const editorProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock("./SlideEditor", () => ({
  SlideEditor: (props: Record<string, unknown>) => {
    editorProps.last = props;
    return null;
  },
  BurnStatusChip: () => null,
  BurnActionButton: () => null,
  useVideoSlides: () => ({ doc: { intro: [], outro: [] }, burnStatus: "none", burnError: null }),
}));
vi.mock("./VideoSubtitles", () => ({
  SubtitleChips: () => null,
  SubtitleDetails: () => null,
  useVideoSubtitles: () => ({}),
}));

import { EventVideosSection } from "./EventVideosSection";
import type { EventVideo } from "../utils/trackParser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  authFetch.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const video = (over: Partial<EventVideo> = {}): EventVideo => ({
  id: 5,
  eventId: 1,
  bunnyVideoId: "g",
  position: 0,
  titleEn: "Morning",
  titlePt: "Manhã",
  videoDate: null,
  durationSeconds: 60,
  posterUrl: null,
  ...over,
});

const mount = (
  v: EventVideo,
  onVideosChange = vi.fn(),
  extra: Partial<React.ComponentProps<typeof EventVideosSection>> = {},
) =>
  act(() =>
    root.render(
      <EventVideosSection
        videos={[v]}
        onVideosChange={onVideosChange}
        onUpload={vi.fn()}
        onImportUrl={vi.fn(async () => undefined)}
        onAttachMaster={vi.fn()}
        {...extra}
      />,
    ),
  );

const progress = (over: Record<string, unknown> = {}) => ({
  phase: "uploading" as const,
  currentFilename: "a.mp4",
  fileProgress: 0.25,
  filesCompleted: 0,
  filesTotal: 1,
  bytesUploaded: 25,
  bytesTotal: 100,
  speed: 0,
  files: [],
  ...over,
});

describe("EventVideosSection upload progress in the slide editor", () => {
  it("should hand the attach upload's progress to the editor of that video", () => {
    const onCancelUpload = vi.fn();
    mount(video(), vi.fn(), { masterUpload: { videoId: 5, progress: progress() }, onCancelUpload });
    expect(editorProps.last?.videoUpload).toEqual({ phase: "uploading", fraction: 0.25 });
    expect(editorProps.last?.onCancelUpload).toBe(onCancelUpload);
  });

  it("should report a finished upload as done and a failed one with its error", () => {
    mount(video(), vi.fn(), { masterUpload: { videoId: 5, progress: progress({ phase: "done" }) } });
    expect(editorProps.last?.videoUpload).toEqual({ phase: "done", fraction: 1 });
    mount(video(), vi.fn(), { masterUpload: { videoId: 5, progress: progress({ phase: "error", error: "boom" }) } });
    expect(editorProps.last?.videoUpload).toEqual({ phase: "error", fraction: 0.25, error: "boom" });
  });

  it("should not show another video's upload in this editor", () => {
    mount(video(), vi.fn(), { masterUpload: { videoId: 99, progress: progress() } });
    expect(editorProps.last?.videoUpload).toBeNull();
  });
});

describe("EventVideosSection collapsed row", () => {
  it("should show the Portuguese title under the English one", () => {
    mount(video());
    expect(container.querySelector('[data-testid="pt-title-line"]')!.textContent).toBe("Manhã");
  });

  it("should show a placeholder when the video has no Portuguese title", () => {
    mount(video({ titlePt: null }));
    expect(container.querySelector('[data-testid="pt-title-line"]')!.textContent).toBe(
      "padmakara.events.noPtTitle",
    );
  });

  it("should persist titlePtReviewed from the chip without opening the editor", async () => {
    const onVideosChange = vi.fn();
    mount(video({ titlePtReviewed: false }), onVideosChange);
    const chip = [...container.querySelectorAll<HTMLElement>(".MuiChip-root")].find((c) =>
      c.textContent?.includes("padmakara.events.aiChipLabel"),
    )!;
    await act(async () => chip.click());

    expect(authFetch).toHaveBeenCalledTimes(1);
    const [url, init] = authFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/videos/5");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ titlePtReviewed: true });
    expect(onVideosChange).toHaveBeenCalledTimes(1);
    expect(container.querySelector("input")?.getAttribute("placeholder") ?? "").not.toContain("titleEn");
  });
});
