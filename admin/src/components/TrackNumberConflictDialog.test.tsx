/** The dialog offered when a moved track lands on a number already used in its language. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key} ${JSON.stringify(opts)}` : key,
}));

import { TrackNumberConflictDialog, trackNumberConflictOf, type TrackNumberConflict } from "./TrackNumberConflictDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONFLICT: TrackNumberConflict = {
  sessionNumber: 4,
  trackNumber: 93,
  language: "pt",
  blocking: { id: 54951, title: "7 de Outubro - sessão da tarde - tradução integral" },
  suggestedForBlocking: 92,
  suggestedForMoved: 95,
};

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

const open = (onResolve = vi.fn(), onCancel = vi.fn()) => {
  act(() =>
    root.render(
      <TrackNumberConflictDialog conflict={CONFLICT} movedTitle="Questão extra" onResolve={onResolve} onCancel={onCancel} />,
    ),
  );
  return { onResolve, onCancel };
};

const byTestId = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const input = (id: string) => byTestId(id)?.querySelector("input") as HTMLInputElement;
const confirm = () => byTestId("conflict-confirm") as HTMLButtonElement;

function type(el: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setValue?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TrackNumberConflictDialog", () => {
  it("should name the track in the way", () => {
    open();

    expect(document.body.textContent).toContain("7 de Outubro - sessão da tarde - tradução integral");
  });

  it("should renumber the track in the way to the suggested number by default", () => {
    const { onResolve } = open();

    act(() => confirm().click());

    expect(onResolve).toHaveBeenCalledWith({ renumber: "blocking", number: 92 });
  });

  it("should renumber the moved track instead when that option is chosen", () => {
    const { onResolve } = open();

    act(() => (byTestId("conflict-option-moved")?.querySelector("input[type=radio]") as HTMLInputElement).click());
    act(() => confirm().click());

    expect(onResolve).toHaveBeenCalledWith({ renumber: "moved", number: 95 });
  });

  it("should use the number typed for the chosen option", () => {
    const { onResolve } = open();

    act(() => type(input("conflict-number-blocking"), "90"));
    act(() => confirm().click());

    expect(onResolve).toHaveBeenCalledWith({ renumber: "blocking", number: 90 });
  });

  it("should not confirm the number already taken", () => {
    open();

    act(() => type(input("conflict-number-blocking"), "93"));

    expect(confirm().disabled).toBe(true);
  });

  it("should cancel without renumbering anything", () => {
    const { onResolve, onCancel } = open();

    act(() => (byTestId("conflict-cancel") as HTMLButtonElement).click());

    expect(onCancel).toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });
});

describe("trackNumberConflictOf", () => {
  it("should read the conflict from the API's 409", () => {
    const err = { status: 409, body: { code: "TRACK_NUMBER_TAKEN", details: CONFLICT } };

    expect(trackNumberConflictOf(err)).toEqual(CONFLICT);
  });

  it("should ignore any other error", () => {
    expect(trackNumberConflictOf({ status: 409, body: { code: "CONFLICT" } })).toBeNull();
    expect(trackNumberConflictOf(new Error("network"))).toBeNull();
  });
});
