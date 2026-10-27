/** Review-account chip and warning on the users admin. Mounted with react-dom directly. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
}));

import { ReviewAccountChip, ReviewAccountWarning } from "./ReviewAccount";

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

describe("ReviewAccountChip", () => {
  it("should show the chip when the user is the review account", () => {
    act(() => root.render(<ReviewAccountChip record={{ isReviewAccount: true }} />));
    expect(container.querySelector('[data-testid="review-account-chip"]')?.textContent).toBe(
      "padmakara.users.reviewAccount",
    );
  });

  it("should render nothing for other users", () => {
    act(() => root.render(<ReviewAccountChip record={{ isReviewAccount: false }} />));
    expect(container.innerHTML).toBe("");
  });
});

describe("ReviewAccountWarning", () => {
  it("should warn against deleting or changing groups on the review account", () => {
    act(() => root.render(<ReviewAccountWarning record={{ isReviewAccount: true }} />));
    expect(container.textContent).toContain("padmakara.users.reviewAccountWarning");
  });

  it("should render nothing for other users", () => {
    act(() => root.render(<ReviewAccountWarning record={{}} />));
    expect(container.innerHTML).toBe("");
  });
});
