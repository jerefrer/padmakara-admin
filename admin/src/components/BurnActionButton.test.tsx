// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string, opts?: { _?: string }) => opts?._ ?? key,
  useNotify: () => vi.fn(),
}));
vi.mock("../utils/authFetch", () => ({ authFetch: vi.fn() }));

import { BurnActionButton } from "./SlideEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onReburn = vi.fn();

const render = (props: Partial<React.ComponentProps<typeof BurnActionButton>> = {}) =>
  act(() =>
    root.render(
      <BurnActionButton hasMaster slideCount={2} burnStatus="failed" reburning={false} onReburn={onReburn} {...props} />,
    ),
  );
const button = () => container.querySelector("button") as HTMLButtonElement | null;

beforeEach(() => {
  onReburn.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BurnActionButton", () => {
  it("should render nothing when there is no retained master", async () => {
    await render({ hasMaster: false });
    expect(button()).toBeNull();
  });
  it("should render nothing when the video has no slides", async () => {
    await render({ slideCount: 0 });
    expect(button()).toBeNull();
  });
  it("should render nothing when the burn is done", async () => {
    await render({ burnStatus: "done" });
    expect(button()).toBeNull();
  });
  it("should show Retry when the burn failed", async () => {
    await render();
    expect(button()?.textContent).toBe("Retry");
  });
  it("should show Burn slides when the burn is pending", async () => {
    await render({ burnStatus: "pending" });
    expect(button()?.textContent).toBe("Burn slides");
  });
  it("should call onReburn when clicked", async () => {
    await render();
    await act(async () => button()!.click());
    expect(onReburn).toHaveBeenCalledTimes(1);
  });
  it("should be disabled while reburning", async () => {
    await render({ reburning: true });
    expect(button()!.disabled).toBe(true);
  });
});
