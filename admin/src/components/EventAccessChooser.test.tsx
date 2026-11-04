/** Access chooser: audience options matched by slug, and the sale fields they write. */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key.replace(/^padmakara\.eventAccessChooser\./, ""),
  useNotify: () => vi.fn(),
}));

import {
  ACCESS_OPTIONS,
  EventAccessChooser,
  accessSummary,
  type AudienceChoice,
  type GroupChoice,
  type SaleValue,
} from "./EventAccessChooser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Ids deliberately differ from slug order: the chooser must go by slug.
const AUDIENCES: AudienceChoice[] = ACCESS_OPTIONS.map((o, i) => ({
  id: 100 - i,
  nameEn: `DB name ${o.slug}`,
  namePt: null,
  slug: o.slug,
}));
const GROUPS: GroupChoice[] = [{ id: 1, nameEn: "Grupo A", namePt: null, abbreviation: "GA" }];

let container: HTMLDivElement;
let root: Root;
let latestAudience: AudienceChoice | null;
let latestSale: SaleValue;
const writeText = vi.fn().mockResolvedValue(undefined);
const onAudienceSpy = vi.fn();
const onSaleSpy = vi.fn();

function Harness({
  audienceSlug,
  sale,
  eventId,
  audiences = AUDIENCES,
}: {
  audienceSlug: string | null;
  sale: SaleValue;
  eventId?: number;
  audiences?: AudienceChoice[];
}) {
  const [audience, setAudience] = useState<AudienceChoice | null>(
    audiences.find((a) => a.slug === audienceSlug) ?? null,
  );
  const [value, setValue] = useState(sale);
  const [groups, setGroups] = useState<GroupChoice[]>([]);
  latestAudience = audience;
  latestSale = value;
  return (
    <EventAccessChooser
      audiences={audiences}
      selectedAudience={audience}
      onAudienceChange={(a) => {
        onAudienceSpy(a);
        setAudience(a);
      }}
      sale={value}
      onSaleChange={(patch) => {
        onSaleSpy(patch);
        setValue((v) => ({ ...v, ...patch }));
      }}
      groups={GROUPS}
      selectedGroups={groups}
      onGroupsChange={setGroups}
      locale="en"
      eventId={eventId}
      stats={{ paidCount: 3, collectedCents: 4500, pendingCount: 1 }}
    />
  );
}

const NONE: SaleValue = { saleMode: "none", priceCents: null, includedInMembership: false };
const mount = (props: Parameters<typeof Harness>[0]) => act(() => root.render(<Harness {...props} />));

const radio = (slug: string) => container.querySelector(`input[type="radio"][value="${slug}"]`) as HTMLInputElement;
const priceInput = () => container.querySelector('input[inputmode="decimal"]') as HTMLInputElement | null;
const othersSwitch = () => container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
const hasGroupsPicker = () => container.textContent?.includes("padmakara.events.retreatGroups") ?? false;
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

describe("EventAccessChooser options", () => {
  it.each([
    ["free-anyone", "none", null],
    ["free-subscribers", "none", null],
    ["retreat-group-members", "none", null],
    ["event-participants", "none", null],
    ["received-initiation", "none", null],
    ["available-on-request-only", "none", null],
    ["restricted", "none", null],
    ["everyone-paid", "paid", 1500],
    ["member-extra-subscription", "paid", 1500],
  ])("should pick the %s audience by slug and save saleMode %s with price %s", (slug, saleMode, price) => {
    mount({ audienceSlug: null, sale: NONE });
    act(() => radio(slug).click());
    expect(latestAudience?.slug).toBe(slug);
    expect(latestAudience?.id).toBe(AUDIENCES.find((a) => a.slug === slug)!.id);
    expect(latestSale.saleMode).toBe(saleMode);
    expect(latestSale.priceCents).toBe(price);
    expect(latestSale.includedInMembership).toBe(false);
  });

  it("should show the three groups of options with their i18n titles, not the database names", () => {
    mount({ audienceSlug: null, sale: NONE });
    expect(container.textContent).toContain("groupFree");
    expect(container.textContent).toContain("groupPaid");
    expect(container.textContent).toContain("groupHand");
    expect(container.textContent).toContain("options.everyone.title");
    expect(container.textContent).not.toContain("DB name");
  });

  it("should disable an option whose audience row does not exist", () => {
    mount({ audienceSlug: null, sale: NONE, audiences: AUDIENCES.filter((a) => a.slug !== "everyone-paid") });
    expect(radio("everyone-paid").disabled).toBe(true);
    expect(radio("free-anyone").disabled).toBe(false);
  });

  it("should reset the sale when moving from a paid option to a free one", () => {
    mount({ audienceSlug: "everyone-paid", sale: { ...NONE, saleMode: "paid", priceCents: 2000 } });
    act(() => radio("free-anyone").click());
    expect(latestSale).toEqual(NONE);
  });

  it("should keep an existing price when moving between paid options", () => {
    mount({ audienceSlug: "everyone-paid", sale: { ...NONE, saleMode: "paid", priceCents: 2000 } });
    act(() => radio("member-extra-subscription").click());
    expect(latestSale.priceCents).toBe(2000);
  });
});

describe("EventAccessChooser controls", () => {
  it("should offer the retreat group picker only for retreat group members", () => {
    mount({ audienceSlug: "retreat-group-members", sale: NONE });
    expect(hasGroupsPicker()).toBe(true);
    for (const slug of ["free-anyone", "free-subscribers", "event-participants", "everyone-paid", "restricted"]) {
      act(() => radio(slug).click());
      expect(hasGroupsPicker()).toBe(false);
    }
  });

  it.each(["retreat-group-members", "event-participants", "free-subscribers"])(
    "should offer Others can buy it for %s and fill 15.00 when turned on",
    (slug) => {
      mount({ audienceSlug: slug, sale: NONE });
      expect(othersSwitch()).not.toBeNull();
      expect(priceInput()).toBeNull();
      act(() => othersSwitch()!.click());
      expect(latestSale.saleMode).toBe("paid");
      expect(latestSale.priceCents).toBe(1500);
      expect(priceInput()!.value).toBe("15.00");
      act(() => othersSwitch()!.click());
      expect(latestSale.saleMode).toBe("none");
      expect(latestSale.priceCents).toBeNull();
    },
  );

  it.each(["free-anyone", "everyone-paid", "member-extra-subscription", "received-initiation", "available-on-request-only", "restricted"])(
    "should not offer Others can buy it for %s",
    (slug) => {
      mount({ audienceSlug: slug, sale: slug.includes("paid") || slug.includes("extra") ? { ...NONE, saleMode: "paid", priceCents: 1500 } : NONE });
      expect(othersSwitch()).toBeNull();
    },
  );

  it("should show the price field for paid options and convert typed euros to cents", () => {
    mount({ audienceSlug: "everyone-paid", sale: { ...NONE, saleMode: "paid", priceCents: 1500 } });
    typeInto(priceInput()!, "12,50");
    expect(latestSale.priceCents).toBe(1250);
  });

  it("should hide the price field when nothing is sold", () => {
    mount({ audienceSlug: "free-anyone", sale: NONE });
    expect(priceInput()).toBeNull();
    mount({ audienceSlug: "received-initiation", sale: NONE });
    expect(priceInput()).toBeNull();
  });

  it("should keep a legacy free sale mode untouched on load, with Others can buy it off", () => {
    mount({ audienceSlug: "free-subscribers", sale: { saleMode: "free", priceCents: null, includedInMembership: true } });
    expect(onSaleSpy).not.toHaveBeenCalled();
    expect(onAudienceSpy).not.toHaveBeenCalled();
    expect(othersSwitch()!.checked).toBe(false);
    expect(latestSale.saleMode).toBe("free");
  });
});

describe("EventAccessChooser link and stats", () => {
  it("should show the shareable link and copy it when something is sold", async () => {
    mount({ audienceSlug: "everyone-paid", sale: { ...NONE, saleMode: "paid", priceCents: 1500 }, eventId: 42 });
    expect(container.textContent).toContain("https://app.padmakara.pt/get/42");
    const copy = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("padmakara.eventSale.copy"))!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith("https://app.padmakara.pt/get/42");
  });

  it("should show the sale stats when something is sold", () => {
    mount({ audienceSlug: "everyone-paid", sale: { ...NONE, saleMode: "paid", priceCents: 1500 }, eventId: 42 });
    expect(container.textContent).toContain("€45.00");
  });

  it("should not show a link when nothing is sold or the event does not exist yet", () => {
    mount({ audienceSlug: "free-anyone", sale: NONE, eventId: 42 });
    expect(container.textContent).not.toContain("/get/");
    mount({ audienceSlug: "everyone-paid", sale: { ...NONE, saleMode: "paid", priceCents: 1500 } });
    expect(container.textContent).not.toContain("/get/");
  });
});

describe("accessSummary", () => {
  const translate = (key: string, o?: Record<string, unknown>) =>
    key.replace(/^padmakara\.eventAccessChooser\./, "") + (o?.count !== undefined ? `:${o.count}` : "");
  const audience = (slug: string) => AUDIENCES.find((a) => a.slug === slug)!;

  it("should list the option, its groups, the price and the sold count", () => {
    const text = accessSummary({
      audience: audience("retreat-group-members"),
      groups: [GROUPS[0]!, { id: 2, nameEn: "Grupo B", namePt: null, abbreviation: null }],
      sale: { saleMode: "paid", priceCents: 1500, includedInMembership: false },
      stats: { paidCount: 4, collectedCents: 0, pendingCount: 0 },
      locale: "en",
      translate,
    });
    expect(text).toBe("options.groups.title · Grupo A, Grupo B · €15.00 · soldCount:4");
  });

  it("should fall back to the database name for an unknown audience", () => {
    const text = accessSummary({
      audience: { id: 9, nameEn: "Old audience", namePt: null, slug: "legacy" },
      groups: [],
      sale: NONE,
      locale: "en",
      translate,
    });
    expect(text).toBe("Old audience");
  });
});
