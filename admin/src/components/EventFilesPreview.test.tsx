/** Transcript list on the event page: deleting a row goes through an in-app confirmation. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
vi.mock("../utils/authFetch", () => ({ authFetch: vi.fn() }));
vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
  useNotify: () => notify,
  useDataProvider: () => ({ delete: del }),
}));

import { EventFilesPreview } from "./EventFilesPreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const transcript = { id: 7, originalFilename: "guru-yoga.pdf", s3Key: "k", fileSizeBytes: 100, language: "en" };

let container: HTMLDivElement;
let root: Root;
const onDeleted = vi.fn();
const flush = () => act(async () => { await Promise.resolve(); });
const trash = () =>
  container.querySelector("[data-testid=DeleteOutlineIcon]")!.closest("button") as HTMLButtonElement;
const dialogButton = (label: string) =>
  [...document.body.querySelectorAll("[role=dialog] button")].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement | undefined;

beforeEach(async () => {
  del.mockResolvedValue({ data: transcript });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(<EventFilesPreview transcripts={[transcript]} onTranscriptDeleted={onDeleted} />),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("EventFilesPreview transcript delete", () => {
  it("should delete the transcript and reload when confirmed", async () => {
    await act(async () => trash().click());
    expect(del).not.toHaveBeenCalled();
    await act(async () => dialogButton("padmakara.transcript.deleteAction")!.click());
    await flush();
    expect(del).toHaveBeenCalledWith("transcripts", { id: 7 });
    expect(onDeleted).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("padmakara.transcript.deleted", { type: "success" });
  });

  it("should keep the transcript when the confirmation is cancelled", async () => {
    await act(async () => trash().click());
    await act(async () => dialogButton("padmakara.events.cancel")!.click());
    expect(del).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("should show an error and not reload when the API delete fails", async () => {
    del.mockRejectedValueOnce(new Error("boom"));
    await act(async () => trash().click());
    await act(async () => dialogButton("padmakara.transcript.deleteAction")!.click());
    await flush();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("boom"), { type: "error" });
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
