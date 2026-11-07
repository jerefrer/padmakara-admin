/** Event status controls: the toggle reports changes, the star needs a saved event. */

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

  it("should report the new status when the other option is clicked", () => {
    const onStatusChange = vi.fn();
    act(() => root.render(<EventStatusControls status="draft" onStatusChange={onStatusChange} />));

    act(() => button("published").click());

    expect(onStatusChange).toHaveBeenCalledWith("published");
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

  describe("media visibility toggles", () => {
    const media = (over: Partial<{ audioPublished: boolean; videoPublished: boolean }> = {}) => ({
      audioPublished: true,
      videoPublished: true,
      onChange: vi.fn(),
      ...over,
    });
    const toggle = (kind: "audio" | "video") =>
      host.querySelector(`button[data-media="${kind}"]`) as HTMLButtonElement | null;

    it("should show the audio and video toggles when the event is published", () => {
      act(() => root.render(<EventStatusControls status="published" onStatusChange={() => {}} media={media()} />));

      expect(toggle("audio")).not.toBeNull();
      expect(toggle("video")).not.toBeNull();
    });

    it("should not show the toggles when the event is a draft", () => {
      act(() => root.render(<EventStatusControls status="draft" onStatusChange={() => {}} media={media()} />));

      expect(toggle("audio")).toBeNull();
      expect(toggle("video")).toBeNull();
    });

    it("should not show the toggles when no media settings are given", () => {
      act(() => root.render(<EventStatusControls status="published" onStatusChange={() => {}} />));

      expect(toggle("audio")).toBeNull();
    });

    it("should report the audio switched off when the visible audio toggle is clicked", () => {
      const m = media();
      act(() => root.render(<EventStatusControls status="published" onStatusChange={() => {}} media={m} />));

      act(() => toggle("audio")!.click());

      expect(m.onChange).toHaveBeenCalledWith("audioPublished", false);
    });

    it("should report the video switched on when the hidden video toggle is clicked", () => {
      const m = media({ videoPublished: false });
      act(() => root.render(<EventStatusControls status="published" onStatusChange={() => {}} media={m} />));

      act(() => toggle("video")!.click());

      expect(m.onChange).toHaveBeenCalledWith("videoPublished", true);
    });

    it("should describe a visible toggle as visible and a hidden one as hidden", () => {
      act(() =>
        root.render(
          <EventStatusControls status="published" onStatusChange={() => {}} media={media({ videoPublished: false })} />,
        ),
      );

      expect(toggle("audio")!.getAttribute("aria-label")).toBe("padmakara.events.mediaVisible");
      expect(toggle("video")!.getAttribute("aria-label")).toBe("padmakara.events.mediaHidden");
    });

    it("should mark a visible toggle as pressed and a hidden one as not pressed", () => {
      act(() =>
        root.render(
          <EventStatusControls status="published" onStatusChange={() => {}} media={media({ videoPublished: false })} />,
        ),
      );

      expect(toggle("audio")!.getAttribute("aria-pressed")).toBe("true");
      expect(toggle("video")!.getAttribute("aria-pressed")).toBe("false");
    });
  });
});
