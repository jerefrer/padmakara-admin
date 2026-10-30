/** Event edit action row: primary Save stays, Save & close leaves. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
}));

import { EventEditActions } from "./EventEditActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const handlers = () => ({
  onDelete: vi.fn(),
  onCancel: vi.fn(),
  onSave: vi.fn(),
  onSaveAndClose: vi.fn(),
});

const render = (props: Partial<React.ComponentProps<typeof EventEditActions>> = {}) => {
  const h = handlers();
  act(() =>
    root.render(<EventEditActions saving={false} deleting={false} canSave {...h} {...props} />),
  );
  return h;
};

const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as
    | HTMLButtonElement
    | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("EventEditActions", () => {
  it("should save without closing when the primary Save is clicked", () => {
    const h = render();
    act(() => button("padmakara.events.saveChanges")!.click());
    expect(h.onSave).toHaveBeenCalledTimes(1);
    expect(h.onSaveAndClose).not.toHaveBeenCalled();
  });

  it("should save and close when Save & close is clicked", () => {
    const h = render();
    act(() => button("padmakara.events.saveAndClose")!.click());
    expect(h.onSaveAndClose).toHaveBeenCalledTimes(1);
    expect(h.onSave).not.toHaveBeenCalled();
  });

  it("should keep Delete and Cancel", () => {
    const h = render();
    act(() => button("padmakara.events.delete")!.click());
    act(() => button("padmakara.events.cancel")!.click());
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("should disable both save buttons when saving is not allowed", () => {
    render({ canSave: false });
    expect(button("padmakara.events.saveChanges")!.disabled).toBe(true);
    expect(button("padmakara.events.saveAndClose")!.disabled).toBe(true);
  });
});
