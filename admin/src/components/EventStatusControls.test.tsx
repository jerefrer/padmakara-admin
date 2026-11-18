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

  it("should offer Draft, Forthcoming and Published", () => {
    act(() => root.render(<EventStatusControls status="draft" onStatusChange={() => {}} />));

    expect(button("draft")).not.toBeNull();
    expect(button("forthcoming")).not.toBeNull();
    expect(button("published")).not.toBeNull();
    expect(host.textContent).toContain("padmakara.events.forthcoming");
  });

  it("should mark the forthcoming button as the selected one for a forthcoming event", () => {
    act(() => root.render(<EventStatusControls status="forthcoming" onStatusChange={() => {}} />));

    expect(button("forthcoming").getAttribute("aria-pressed")).toBe("true");
    expect(button("published").getAttribute("aria-pressed")).toBe("false");
  });

  it("should ask with the forthcoming copy before showing an event as forthcoming", () => {
    const onStatusChange = vi.fn();
    act(() => root.render(<EventStatusControls status="draft" onStatusChange={onStatusChange} />));

    act(() => button("forthcoming").click());
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("padmakara.events.confirmForthcomingTitle");
    expect(document.body.textContent).toContain("padmakara.events.confirmForthcomingMessage");

    act(() => dialogButton("confirm-change-ok")!.click());
    expect(onStatusChange).toHaveBeenCalledWith("forthcoming", undefined);
  });

  it("should not offer section boxes for forthcoming", () => {
    act(() =>
      root.render(<EventStatusControls status="draft" onStatusChange={() => {}} publishSections={SECTIONS} />),
    );

    act(() => button("forthcoming").click());

    expect(sectionBox("audioPublished")).toBeNull();
  });

  describe("publishing never emails", () => {
    it("should offer no email box, message field or already-emailed note in the publish dialog", () => {
      act(() =>
        root.render(<EventStatusControls status="forthcoming" onStatusChange={() => {}} publishSections={SECTIONS} />),
      );

      act(() => button("published").click());

      const dialog = document.body.innerHTML;
      expect(dialog).not.toContain("notify-on-publish");
      expect(dialog).not.toContain("notify-message");
      expect(dialog).not.toContain("already-notified");
      expect(document.body.querySelector("textarea")).toBeNull();
    });

    it("should report only the status and the sections when confirmed", () => {
      const onStatusChange = vi.fn();
      act(() =>
        root.render(<EventStatusControls status="forthcoming" onStatusChange={onStatusChange} publishSections={SECTIONS} />),
      );

      act(() => button("published").click());
      act(() => dialogButton("confirm-change-ok")!.click());

      expect(onStatusChange).toHaveBeenCalledWith("published", { audioPublished: true, videoPublished: false });
      expect(onStatusChange.mock.calls[0]).toHaveLength(2);
    });
  });
});
