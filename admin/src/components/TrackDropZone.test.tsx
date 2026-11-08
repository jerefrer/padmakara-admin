/** The folder drop zone: full-size while creating an event, one line when adding sessions to an existing one. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({ useTranslate: () => (key: string) => key }));

import { TrackDropZone } from "./TrackDropZone";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("TrackDropZone", () => {
  it("should explain the folder name parsing when shown full size", () => {
    act(() => root.render(<TrackDropZone onFolderDropped={vi.fn()} fileCount={0} folderName={null} />));
    expect(host.textContent).toContain("padmakara.dropzone.subtitle");
  });

  it("should offer an add link instead of the big box when compact", () => {
    act(() => root.render(<TrackDropZone compact onFolderDropped={vi.fn()} fileCount={0} folderName={null} />));
    expect(host.textContent).toContain("padmakara.dropzone.addSessions");
    expect(host.textContent).not.toContain("padmakara.dropzone.subtitle");
  });

  it("should pass the picked folder's audio files on, parsed, when a folder is chosen", () => {
    const onFolderDropped = vi.fn();
    act(() => root.render(<TrackDropZone compact onFolderDropped={onFolderDropped} fileCount={0} folderName={null} />));
    const input = host.querySelector('input[type="file"]') as HTMLInputElement;
    const file = (path: string) => {
      const f = new File(["x"], path.split("/").pop()!, { type: "audio/mpeg" });
      Object.defineProperty(f, "webkitRelativePath", { value: path });
      return f;
    };
    const files = [file("2019-10-06 Event/002 Second.mp3"), file("2019-10-06 Event/001 First.mp3"), file("2019-10-06 Event/notes.txt")];
    Object.defineProperty(input, "files", { value: files });

    act(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });

    expect(onFolderDropped).toHaveBeenCalledTimes(1);
    const [, tracks] = onFolderDropped.mock.calls[0];
    expect(tracks.map((t: { file: File }) => t.file.name)).toEqual(["001 First.mp3", "002 Second.mp3"]);
  });
});
