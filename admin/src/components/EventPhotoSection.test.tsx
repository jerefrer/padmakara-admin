/** Event photo editor: hint, no separate avatar editor, remove button only when a photo exists, DELETE call. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authFetch, notify, refresh } = vi.hoisted(() => ({
  authFetch: vi.fn(),
  notify: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("react-admin", () => ({
  useRecordContext: () => undefined,
  useNotify: () => notify,
  useRefresh: () => refresh,
}));
vi.mock("../utils/authFetch", () => ({ authFetch }));
vi.mock("./HeroFramePreviews", () => ({ HeroFramePreviews: () => <div data-testid="previews" /> }));
vi.mock("./ImageCropDialog", () => ({ ImageCropDialog: () => null, applyGrayscale: () => undefined }));

import { EventPhotoSection } from "./EventPhotoSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("EventPhotoSection", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (record: Record<string, unknown>) => act(() => root.render(<EventPhotoSection record={record} />));

  it("should show the optional hint and no separate avatar editor", () => {
    render({ id: 5, titleEn: "Hong Kong" });
    expect(host.textContent).toContain("Optional. Replaces the teachers' photos for this event");
    expect(host.textContent).not.toContain("Avatar");
  });

  it("should not offer to remove a photo the event does not have", () => {
    render({ id: 5, titleEn: "Hong Kong" });
    expect(host.textContent).not.toContain("Remove photo");
    expect(host.textContent).toContain("Upload photo");
  });

  it("should delete the photo through the admin API when removing", async () => {
    authFetch.mockResolvedValue({ ok: true });
    render({ id: 5, titleEn: "Hong Kong", heroUrl: "https://signed/hero.webp", heroFocalX: 50, heroFocalY: 50 });
    const button = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Remove photo"));
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(authFetch).toHaveBeenCalledWith("/api/admin/events/5/photo", { method: "DELETE" });
    expect(refresh).toHaveBeenCalled();
  });
});
