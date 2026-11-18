/**
 * Transcript list on the event page: deleting a row goes through an in-app
 * confirmation, and each row edits its own metadata with a PATCH that sends only
 * the field that changed.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const authFetch = vi.hoisted(() => vi.fn());
vi.mock("../utils/authFetch", () => ({ authFetch }));
vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
  useNotify: () => notify,
  useDataProvider: () => ({ delete: del }),
}));

import { EventFilesPreview } from "./EventFilesPreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const transcript = {
  id: 7,
  originalFilename: "guru-yoga.pdf",
  s3Key: "k",
  fileSizeBytes: 100,
  language: "en",
  status: "final",
  isExcerpt: false,
  published: true,
  pageCount: 42,
};

let container: HTMLDivElement;
let root: Root;
const onDeleted = vi.fn();
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
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

/** Set a native <select>'s value the way a user does, so React sees the change. */
function choose(select: HTMLSelectElement, value: string) {
  // The value setter always exists on HTMLSelectElement.prototype
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

const patchBodies = () =>
  authFetch.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")
    .map(([url, init]) => [url, JSON.parse(String((init as RequestInit).body))]);

const byTestId = <T extends Element>(id: string) => container.querySelector(`[data-testid=${id}]`) as T;

describe("EventFilesPreview transcript metadata", () => {
  beforeEach(() => {
    authFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify({ ...transcript, ...JSON.parse(String(init?.body ?? "{}")) }), { status: 200 }),
    );
  });

  it("should send only the status when the status changes", async () => {
    await act(async () => choose(byTestId<HTMLSelectElement>("transcript-status-7"), "provisional"));
    await flush();
    expect(patchBodies()).toEqual([["/api/admin/transcripts/7", { status: "provisional" }]]);
  });

  it("should send only the language when the language changes", async () => {
    await act(async () => choose(byTestId<HTMLSelectElement>("transcript-language-7"), "tib"));
    await flush();
    expect(patchBodies()).toEqual([["/api/admin/transcripts/7", { language: "tib" }]]);
  });

  it("should send only isExcerpt when the excerpts box is ticked", async () => {
    await act(async () => byTestId<HTMLInputElement>("transcript-excerpt-7").click());
    await flush();
    expect(patchBodies()).toEqual([["/api/admin/transcripts/7", { isExcerpt: true }]]);
  });

  it("should send only published when the switch is turned off, and show the unpublished chip", async () => {
    await act(async () => byTestId<HTMLInputElement>("transcript-published-7").click());
    await flush();
    expect(patchBodies()).toEqual([["/api/admin/transcripts/7", { published: false }]]);
    expect(container.textContent).toContain("padmakara.transcript.unpublished");
  });

  it("should show the unpublished chip for a file that is off", async () => {
    await act(async () =>
      root.render(<EventFilesPreview transcripts={[{ ...transcript, published: false }]} />),
    );
    expect(container.textContent).toContain("padmakara.transcript.unpublished");
  });

  it("should not show the unpublished chip for a published file", () => {
    expect(container.textContent).not.toContain("padmakara.transcript.unpublished");
  });

  it("should show the page count read-only", () => {
    expect(byTestId("transcript-pages-7").textContent).toContain("42");
  });

  it("should put the control back and report the error when the PATCH fails", async () => {
    authFetch.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const select = byTestId<HTMLSelectElement>("transcript-status-7");
    await act(async () => choose(select, "draft"));
    await flush();
    expect(select.value).toBe("final");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("padmakara.transcript.updateFailed"), { type: "error" });
  });
});
