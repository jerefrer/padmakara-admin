import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasUnsavedCreateWork, useLeaveGuard } from "./useLeaveGuard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Guard = ({ armed }: { armed: boolean }) => {
  useLeaveGuard(armed);
  return null;
};

const none = { hasFolder: false, formChanged: false, selectionCount: 0, transcriptCount: 0, documentCount: 0 };

/** Dispatches a cancelable beforeunload and reports whether a prompt was requested. */
const leavePrompted = (): boolean => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

describe("hasUnsavedCreateWork", () => {
  it("should report nothing to lose when the page is untouched", () => {
    expect(hasUnsavedCreateWork(none)).toBe(false);
  });

  it.each([
    ["a folder is loaded", { hasFolder: true }],
    ["a form field changed", { formChanged: true }],
    ["a teacher or group is selected", { selectionCount: 1 }],
    ["a transcript is queued", { transcriptCount: 1 }],
    ["a document is queued", { documentCount: 1 }],
  ])("should report unsaved work when %s", (_label, change) => {
    expect(hasUnsavedCreateWork({ ...none, ...change })).toBe(true);
  });
});

describe("useLeaveGuard", () => {
  let root: Root;
  const render = (armed: boolean) => act(() => root.render(<Guard armed={armed} />));

  beforeEach(() => {
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => act(() => root.unmount()));

  it("should ask before the tab closes while armed", () => {
    render(true);
    expect(leavePrompted()).toBe(true);
  });

  it("should not ask when not armed", () => {
    render(false);
    expect(leavePrompted()).toBe(false);
  });

  it("should stop asking once disarmed after a save", () => {
    render(true);
    render(false);
    expect(leavePrompted()).toBe(false);
  });

  it("should stop asking when the page unmounts", () => {
    render(true);
    act(() => root.unmount());
    root = createRoot(document.createElement("div"));
    expect(leavePrompted()).toBe(false);
  });
});
