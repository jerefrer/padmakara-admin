/** Event status controls: the toggle asks before reporting a change, the star needs a saved event. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
}));
vi.mock("./FeatureStarButton", () => ({
  FeatureStarButton: () => <button data-testid="star" />,
}));

import { EventStatusControls } from "./EventStatusControls";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STAR = { eventId: 1, featured: false, title: "T", titleOf: () => "T", onFeatured: () => {} };

describe("EventStatusControls", () => {
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

  const button = (value: string) => host.querySelector(`button[value="${value}"]`) as HTMLButtonElement;

  const dialogButton = (testId: string) =>
    document.body.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;

  it("should ask before publishing and report the new status once confirmed", () => {
    const onStatusChange = vi.fn();
    act(() => root.render(<EventStatusControls status="draft" onStatusChange={onStatusChange} />));

    act(() => button("published").click());
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("padmakara.events.confirmPublishTitle");

    act(() => dialogButton("confirm-change-ok")!.click());
    expect(onStatusChange).toHaveBeenCalledWith("published", undefined);
  });

  const SECTIONS = [
    { key: "audioPublished" as const, label: "Audio", checked: true },
    { key: "videoPublished" as const, label: "Video", detail: "nothing yet", checked: false },
  ];
  const sectionBox = (key: string) =>
    document.body.querySelector(`input[data-publish-section="${key}"]`) as HTMLInputElement | null;

  it("should offer the section boxes when publishing, ticked as given", () => {
    act(() => root.render(<EventStatusControls status="draft" onStatusChange={() => {}} publishSections={SECTIONS} />));

    act(() => button("published").click());

    expect(sectionBox("audioPublished")!.checked).toBe(true);
    expect(sectionBox("videoPublished")!.checked).toBe(false);
    expect(document.body.textContent).toContain("nothing yet");
  });

  it("should report the boxes as chosen in the dialog with the new status", () => {
    const onStatusChange = vi.fn();
    act(() => root.render(<EventStatusControls status="draft" onStatusChange={onStatusChange} publishSections={SECTIONS} />));

    act(() => button("published").click());
    act(() => sectionBox("audioPublished")!.click());
    act(() => sectionBox("videoPublished")!.click());
    act(() => dialogButton("confirm-change-ok")!.click());

    expect(onStatusChange).toHaveBeenCalledWith("published", { audioPublished: false, videoPublished: true });
  });

  it("should not offer section boxes when unpublishing", () => {
    const onStatusChange = vi.fn();
    act(() => root.render(<EventStatusControls status="published" onStatusChange={onStatusChange} publishSections={SECTIONS} />));

    act(() => button("draft").click());
    expect(sectionBox("audioPublished")).toBeNull();
    act(() => dialogButton("confirm-change-ok")!.click());

    expect(onStatusChange).toHaveBeenCalledWith("draft", undefined);
  });

  it("should ask before unpublishing too", () => {
    const onStatusChange = vi.fn();
    act(() => root.render(<EventStatusControls status="published" onStatusChange={onStatusChange} />));

    act(() => button("draft").click());

    expect(onStatusChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("padmakara.events.confirmUnpublishTitle");
  });

  it("should keep the status when the confirmation is cancelled", () => {
    const onStatusChange = vi.fn();
    act(() => root.render(<EventStatusControls status="draft" onStatusChange={onStatusChange} />));

    act(() => button("published").click());
    act(() => dialogButton("confirm-change-cancel")!.click());

    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("should not report anything when the current status is clicked again", () => {
    const onStatusChange = vi.fn();
    act(() => root.render(<EventStatusControls status="draft" onStatusChange={onStatusChange} />));

    act(() => button("draft").click());

    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("should show the star only when the event exists", () => {
    act(() => root.render(<EventStatusControls status="draft" onStatusChange={() => {}} />));
    expect(host.querySelector('[data-testid="star"]')).toBeNull();

    act(() => root.render(<EventStatusControls status="draft" onStatusChange={() => {}} star={STAR} />));
    expect(host.querySelector('[data-testid="star"]')).not.toBeNull();
  });

  it("should not show Audio or Video toggles, which moved to the Video & audio section", () => {
    act(() => root.render(<EventStatusControls status="published" onStatusChange={() => {}} />));

    expect(host.querySelector("button[data-media]")).toBeNull();
  });
});
