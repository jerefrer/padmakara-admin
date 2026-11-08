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

  it("should keep only the one-line invitation when compact", () => {
    act(() => root.render(<TrackDropZone compact onFolderDropped={vi.fn()} fileCount={0} folderName={null} />));
    expect(host.textContent).toContain("padmakara.dropzone.title");
    expect(host.textContent).not.toContain("padmakara.dropzone.subtitle");
  });
});
