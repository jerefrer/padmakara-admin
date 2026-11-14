// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-admin")>();
  return { ...actual, useTranslate: () => (key: string) => key, useLocaleState: () => ["en", vi.fn()] };
});

import { PageHeader } from "./events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("PageHeader", () => {
  it("should render the title and the actions on separate rows, title first", () => {
    act(() => root.render(<PageHeader title="Guru Yoga" trailing={<button>Expand all</button>} />));
    const title = host.querySelector('[data-testid="page-header-title"]')!;
    const actions = host.querySelector('[data-testid="page-header-actions"]')!;
    expect(title.textContent).toBe("Guru Yoga");
    expect(actions.textContent).toBe("Expand all");
    expect(title.parentElement).not.toBe(actions.parentElement);
    expect(title.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("should show no back button when onBack is not given", () => {
    act(() => root.render(<PageHeader title="Guru Yoga" />));
    expect(host.querySelector("button")).toBeNull();
  });

  it("should show the back button when onBack is given", () => {
    const onBack = vi.fn();
    act(() => root.render(<PageHeader title="New" backLabel="Events" onBack={onBack} />));
    act(() => host.querySelector("button")!.click());
    expect(onBack).toHaveBeenCalled();
  });
});
