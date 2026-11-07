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

  it("should not show Audio or Video toggles, which moved to the Video & audio section", () => {
    act(() => root.render(<EventStatusControls status="published" onStatusChange={() => {}} />));

    expect(host.querySelector("button[data-media]")).toBeNull();
  });
});
