/** A finished transcript upload tells the admin the file is not published yet. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({ useTranslate: () => (key: string) => key }));

import { TranscriptDropZone, type TranscriptUploadState } from "./TranscriptDropZone";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const render = (uploads: TranscriptUploadState[]) =>
  act(async () => root.render(<TranscriptDropZone onFilesDropped={vi.fn()} uploads={uploads} />));

describe("TranscriptDropZone", () => {
  it("should say the file is not published yet once an upload is done", async () => {
    await render([{ filename: "a.pdf", status: "done", progress: 1 }]);

    expect(container.querySelector("[data-testid=transcript-unpublished-hint]")?.textContent).toBe(
      "padmakara.transcript.uploadedUnpublishedHint",
    );
  });

  it("should not show the hint while the upload is still running", async () => {
    await render([{ filename: "a.pdf", status: "uploading", progress: 0.5 }]);

    expect(container.querySelector("[data-testid=transcript-unpublished-hint]")).toBeNull();
  });
});
