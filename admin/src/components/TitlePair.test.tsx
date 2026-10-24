/**
 * Collapsed-row titles: English first line, Portuguese second line, and an
 * AI-review chip that confirms a title without opening the row's editor.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
  useNotify: () => vi.fn(),
}));

import { TitlePair } from "./TitlePair";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const REVIEW = "padmakara.events.aiChipLabel";
const chips = () =>
  [...container.querySelectorAll<HTMLElement>(".MuiChip-root")].filter((c) =>
    c.textContent?.includes(REVIEW),
  );
const ptLine = () => container.querySelector<HTMLElement>('[data-testid="pt-title-line"]');

describe("TitlePair", () => {
  it("should show the Portuguese title on a second line when present", () => {
    act(() => root.render(<TitlePair titleEn="Morning" titlePt="Manhã" fallback="x" onMarkReviewed={vi.fn()} />));
    expect(container.textContent).toContain("Morning");
    expect(ptLine()!.textContent).toBe("Manhã");
    expect(chips()).toHaveLength(0);
  });

  it("should show a placeholder when the Portuguese title is missing", () => {
    act(() => root.render(<TitlePair titleEn="Morning" titlePt={null} fallback="x" onMarkReviewed={vi.fn()} />));
    expect(ptLine()!.textContent).toBe("padmakara.events.noPtTitle");
    expect(chips()).toHaveLength(0);
  });

  it("should mark the Portuguese title reviewed without triggering the row click", () => {
    const onMark = vi.fn();
    const onRowClick = vi.fn();
    act(() =>
      root.render(
        <div onClick={onRowClick}>
          <TitlePair
            titleEn="Morning"
            titlePt="Manhã"
            fallback="x"
            titlePtReviewed={false}
            onMarkReviewed={onMark}
          />
        </div>,
      ),
    );
    expect(chips()).toHaveLength(1);
    act(() => chips()[0]!.click());
    expect(onMark).toHaveBeenCalledExactlyOnceWith("pt");
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("should mark the English title reviewed from the chip next to it", () => {
    const onMark = vi.fn();
    act(() =>
      root.render(
        <TitlePair titleEn="Morning" titlePt="Manhã" fallback="x" titleEnReviewed={false} onMarkReviewed={onMark} />,
      ),
    );
    act(() => chips()[0]!.click());
    expect(onMark).toHaveBeenCalledExactlyOnceWith("en");
  });

  it("should not repeat the Portuguese title when it is the only one", () => {
    act(() =>
      root.render(
        <TitlePair titleEn="" titlePt="Manhã" fallback="x" titlePtReviewed={false} onMarkReviewed={vi.fn()} />,
      ),
    );
    expect(ptLine()).toBeNull();
    expect(container.textContent).toContain("Manhã");
    expect(chips()).toHaveLength(1);
  });
});
