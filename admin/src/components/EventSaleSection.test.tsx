/** "Access & sale" card on the event page. */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
  useNotify: () => vi.fn(),
}));

import { EventSaleSection, type SaleValue } from "./EventSaleSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let latest: SaleValue;
const writeText = vi.fn().mockResolvedValue(undefined);

function Harness({ initial, eventId }: { initial: SaleValue; eventId?: number }) {
  const [value, setValue] = useState(initial);
  latest = value;
  return (
    <EventSaleSection
      value={value}
      onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
      eventId={eventId}
      stats={{ paidCount: 3, collectedCents: 4500, pendingCount: 1 }}
    />
  );
}

const mount = (initial: Partial<SaleValue> = {}, eventId?: number) =>
  act(() =>
    root.render(
      <Harness
        initial={{ saleMode: "none", priceCents: null, includedInMembership: false, ...initial }}
        eventId={eventId}
      />,
    ),
  );

const radio = (value: string) =>
  container.querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement;
const priceInput = () => container.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
const typeInto = (input: HTMLInputElement, text: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("EventSaleSection", () => {
  it("should fill 15.00 when switching to Paid with an empty price", () => {
    mount();
    act(() => radio("paid").click());
    expect(latest.saleMode).toBe("paid");
    expect(latest.priceCents).toBe(1500);
    expect(priceInput().value).toBe("15.00");
  });

  it("should keep an existing price when switching to Paid", () => {
    mount({ saleMode: "free", priceCents: 2000 });
    act(() => radio("paid").click());
    expect(latest.priceCents).toBe(2000);
  });

  it("should convert typed euros to cents", () => {
    mount({ saleMode: "paid", priceCents: 1500 });
    typeInto(priceInput(), "12,50");
    expect(latest.priceCents).toBe(1250);
  });

  it("should hide the price field unless the mode is Paid", () => {
    mount({ saleMode: "free" });
    expect(priceInput()).toBeNull();
  });

  it("should show the shareable link and copy it", async () => {
    mount({ saleMode: "paid", priceCents: 1500 }, 42);
    expect(container.textContent).toContain("https://app.padmakara.pt/get/42");
    const copy = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("padmakara.eventSale.copy"),
    )!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith("https://app.padmakara.pt/get/42");
  });

  it("should not show a link before the event exists", () => {
    mount({ saleMode: "paid", priceCents: 1500 });
    expect(container.textContent).not.toContain("/get/");
  });

  it("should toggle included in membership", () => {
    mount({ saleMode: "free" });
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => box.click());
    expect(latest.includedInMembership).toBe(true);
    act(() => box.click());
    expect(latest.includedInMembership).toBe(false);
  });

  it("should show the sale stats on an existing event", () => {
    mount({ saleMode: "paid", priceCents: 1500 }, 42);
    expect(container.textContent).toContain("€45.00");
  });
});
