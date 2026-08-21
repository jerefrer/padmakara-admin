/**
 * Regression test for the slide editor's rich-text line field.
 *
 * The bug this exists to prevent: a `contentEditable` has no React children,
 * so the seed-from-props effect is the ONLY thing that ever puts text in the
 * box. Initialising the "did this edit come from me?" guard ref to the current
 * spans' HTML made the very first effect run compare equal and bail out — so
 * every field rendered EMPTY while the document (and the preview beside it)
 * held the real content. Worse, blurring the empty field serialised that empty
 * DOM back over the real spans and destroyed the line.
 *
 * Mounted with react-dom directly: this project has no @testing-library, and
 * the whole point is to assert on real DOM produced by a real mount.
 */

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Span } from "@slides/types.ts";

// react-admin pulls a large provider tree we don't need; the component only
// uses it for button tooltips.
vi.mock("react-admin", () => ({ useTranslate: () => (key: string) => key }));

import { RichTextLineField } from "./RichTextLineField";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function editable(): HTMLElement {
  const el = container.querySelector('[contenteditable="true"]');
  if (!el) throw new Error("contentEditable element not found");
  return el as HTMLElement;
}

function mount(spans: Span[], onChange: (s: Span[]) => void = () => {}) {
  act(() => {
    root.render(
      <StrictMode>
        <RichTextLineField spans={spans} onChange={onChange} />
      </StrictMode>,
    );
  });
}

describe("RichTextLineField", () => {
  it("renders the span text into the editable box on first mount", () => {
    mount([{ text: "Tenga Rinpoche" }]);
    // The exact failure reported from the admin: the preview showed the name
    // while every field sat empty on its placeholder.
    expect(editable().textContent).toBe("Tenga Rinpoche");
  });

  it("renders bold/italic/underline marks as real elements", () => {
    mount([
      { text: "Fundação Kangyur Rinpoche", bold: true },
      { text: " — " },
      { text: "Lisboa", italic: true, underline: true },
    ]);
    const el = editable();
    expect(el.querySelector("b, strong")?.textContent).toBe("Fundação Kangyur Rinpoche");
    expect(el.textContent).toContain("Lisboa");
    expect(el.querySelector("i, em")).not.toBeNull();
    expect(el.querySelector("u")).not.toBeNull();
  });

  it("does not report a change merely from being mounted", () => {
    // The destructive half of the bug: an unseeded field that is focused and
    // blurred emits [] and wipes the line. Mounting alone must emit nothing.
    const onChange = vi.fn();
    mount([{ text: "Teachings", italic: true }], onChange);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves content across a blur once seeded", () => {
    const onChange = vi.fn();
    mount([{ text: "21 June 2009" }], onChange);
    act(() => {
      editable().dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });
    // Whatever it emits, it must not have thrown the text away.
    if (onChange.mock.calls.length > 0) {
      const calls = onChange.mock.calls;
      const emitted = calls[calls.length - 1]![0] as Span[];
      expect(emitted.map((s) => s.text).join("")).toBe("21 June 2009");
    }
    expect(editable().textContent).toBe("21 June 2009");
  });

  it("re-seeds when spans are replaced externally (Generate from event data)", () => {
    mount([{ text: "Old title" }]);
    expect(editable().textContent).toBe("Old title");
    mount([{ text: "Jigme Khyentse Rinpoche" }]);
    expect(editable().textContent).toBe("Jigme Khyentse Rinpoche");
  });

  it("renders an empty box for an empty span list without crashing", () => {
    mount([]);
    expect(editable().textContent).toBe("");
  });
});
