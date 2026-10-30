/** Documents section: deleting a row goes through an in-app confirmation. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.hoisted(() => vi.fn());
const getList = vi.hoisted(() => vi.fn());
const del = vi.hoisted(() => vi.fn());
const authFetch = vi.hoisted(() => vi.fn());
vi.mock("../utils/authFetch", () => ({ authFetch }));
vi.mock("../utils/uploadManager", () => ({ uploadFile: vi.fn() }));
vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
  useNotify: () => notify,
  useDataProvider: () => ({ getList, delete: del }),
}));

import { DocumentsSection } from "./DocumentsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = {
  id: 11,
  eventId: 5,
  originalFilename: "2026_04-Guru_Yoga-Transcription-JKR-Portugal.pdf",
  s3Key: "events/E/document/a.pdf",
  fileType: "document",
  extension: "pdf",
  fileSizeBytes: 1000,
  title: null,
  sensitive: false,
  sortOrder: 0,
};

let container: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await Promise.resolve(); });

const trash = () =>
  container.querySelector("[data-testid=DeleteOutlineIcon]")!.closest("button") as HTMLButtonElement;
const dialogButton = (label: string) =>
  [...document.body.querySelectorAll("[role=dialog] button")].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement | undefined;

beforeEach(async () => {
  getList.mockResolvedValue({ data: [row], total: 1 });
  del.mockResolvedValue({ data: row });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<DocumentsSection eventCode="E" eventId={5} />));
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("DocumentsSection delete", () => {
  it("should ask for confirmation without deleting when the trash is clicked", async () => {
    await act(async () => trash().click());
    expect(dialogButton("padmakara.documents.delete")).toBeDefined();
    expect(del).not.toHaveBeenCalled();
  });

  it("should delete the document and drop the row when confirmed", async () => {
    await act(async () => trash().click());
    await act(async () => dialogButton("padmakara.documents.delete")!.click());
    await flush();
    expect(del).toHaveBeenCalledWith("event-files", { id: 11 });
    expect(container.textContent).not.toContain(row.originalFilename);
    expect(notify).toHaveBeenCalledWith("padmakara.documents.deleted", { type: "success" });
  });

  it("should keep the document when the confirmation is cancelled", async () => {
    await act(async () => trash().click());
    await act(async () => dialogButton("padmakara.events.cancel")!.click());
    expect(del).not.toHaveBeenCalled();
    expect(container.textContent).toContain(row.originalFilename);
  });

  it("should show an error and keep the row when the API delete fails", async () => {
    del.mockRejectedValueOnce(new Error("boom"));
    await act(async () => trash().click());
    await act(async () => dialogButton("padmakara.documents.delete")!.click());
    await flush();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("boom"), { type: "error" });
    expect(container.textContent).toContain(row.originalFilename);
  });
});
