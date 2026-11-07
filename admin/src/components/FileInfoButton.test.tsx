// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string, opts?: { _?: string; count?: number }) =>
    opts?._ ? opts._.replace("%{count}", String(opts.count ?? "")) : key,
}));
vi.mock("../utils/authFetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "../utils/authFetch";
import { FileInfoButton } from "./FileInfoButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockFetch = authFetch as ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;

const json = (body: unknown, ok = true) =>
  Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) } as Response);
const flush = () => act(async () => { await Promise.resolve(); });
const open = async () => {
  await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
  await flush();
};
const popover = () => document.body.querySelector('[role="presentation"] .MuiPopover-paper') as HTMLElement | null;

beforeEach(() => {
  mockFetch.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("FileInfoButton", () => {
  it("should not fetch until the icon is clicked", async () => {
    await act(async () => root.render(<FileInfoButton kind="track" id={5} />));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
  });

  it("should show audio details for a track", async () => {
    mockFetch.mockReturnValue(
      json({
        originalFilename: "talk.mp3",
        sizeBytes: 12_345_678,
        format: "mp3",
        durationSeconds: 3725,
        bitrateKbps: 128,
        sampleRateHz: 44100,
        channels: 2,
      }),
    );
    await act(async () => root.render(<FileInfoButton kind="track" id={5} />));
    await open();
    expect(mockFetch).toHaveBeenCalledWith("/api/admin/tracks/5/file-info");
    const text = popover()!.textContent!;
    for (const expected of ["talk.mp3", "11.8 MB", "mp3", "1:02:05", "128 kbps", "44.1 kHz", "Stereo"]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain("Resolution");
  });

  it("should show resolution and frame rate for a video and dashes for unknowns", async () => {
    mockFetch.mockReturnValue(
      json({
        originalFilename: null,
        sizeBytes: null,
        durationSeconds: 60,
        width: 1920,
        height: 1080,
        framerate: 25,
      }),
    );
    await act(async () => root.render(<FileInfoButton kind="video" id={3} />));
    await open();
    expect(mockFetch).toHaveBeenCalledWith("/api/admin/videos/3/file-info");
    const text = popover()!.textContent!;
    expect(text).toContain("1920 × 1080");
    expect(text).toContain("25 fps");
    expect(text).toContain("—");
    expect(text).not.toContain("Bit rate");
  });

  it("should show an error line when the request fails", async () => {
    mockFetch.mockReturnValue(json({}, false));
    await act(async () => root.render(<FileInfoButton kind="track" id={5} />));
    await open();
    expect(popover()!.textContent).toContain("Could not load the file details");
  });
});
