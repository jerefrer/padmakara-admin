/**
 * Bulk "Edit selected…" dialog: every field starts at "leave unchanged" and
 * only the fields the admin touched are sent.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key.replace(/^padmakara\./, ""),
}));

import { MoveTracksBar } from "./MoveTracksBar";

let container: HTMLDivElement;
let root: Root;
const onBulkEdit = vi.fn();

beforeEach(() => {
  onBulkEdit.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MoveTracksBar
        sessions={[]}
        selectedCount={3}
        busy={false}
        defaultDate="2026-04-12"
        onMove={() => {}}
        onClear={() => {}}
        teachers={[{ id: 1, name: "Jigme Khyentse", abbreviation: "JK" }]}
        onBulkEdit={onBulkEdit}
      />,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const byText = (text: string) =>
  [...document.body.querySelectorAll<HTMLElement>("button, [role=button]")].find(
    (el) => el.textContent?.trim() === text,
  )!;
const click = (el: HTMLElement) => act(() => el.click());

describe("EditTracksDialog", () => {
  it("should keep Apply disabled until a field is changed", () => {
    click(byText("tracks.bulk.editSelected"));
    expect((byText("tracks.bulk.apply") as HTMLButtonElement).disabled).toBe(true);
  });

  it("should send only the translation flag when only it was changed", () => {
    click(byText("tracks.bulk.editSelected"));
    click(byText("tracks.bulk.yes"));
    click(byText("tracks.bulk.apply"));
    expect(onBulkEdit).toHaveBeenCalledWith({ isTranslation: true });
  });

  it("should send languages in click order and omit unchanged fields", () => {
    click(byText("tracks.bulk.editSelected"));
    click(byText("Portuguese"));
    click(byText("Tibetan"));
    click(byText("tracks.bulk.apply"));
    expect(onBulkEdit).toHaveBeenCalledWith({ languages: ["pt", "tib"] });
  });
});
