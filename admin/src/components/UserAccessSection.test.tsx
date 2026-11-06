/** Access picker: shows only what the person has; changes stay in the form until Save. */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let value: number[] = [];
let setValue: (v: number[]) => void = () => {};

vi.mock("react-admin", () => ({
  useInput: () => ({ field: { value, onChange: (v: number[]) => setValue(v) } }),
  useTranslate: () => (key: string) => key,
  useNotify: () => vi.fn(),
  useLocaleState: () => ["en"],
  useRecordContext: () => ({}),
}));

const fetchMock = vi.fn();
vi.mock("../utils/authFetch", () => ({ authFetch: (...args: unknown[]) => fetchMock(...args) }));

import { AccessPicker, eventOption, type AccessOption } from "./UserAccessSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS: AccessOption[] = [
  { id: 1, label: "Guru Yoga" },
  { id: 2, label: "Mandala" },
  { id: 3, label: "Vietnamese Study Group" },
];

const Harness = ({ initial }: { initial: number[] }) => {
  const [v, set] = useState(initial);
  value = v;
  setValue = set;
  return (
    <AccessPicker source="ids" title="T" options={OPTIONS} addLabel="add" emptyLabel="none" removeLabel="remove" />
  );
};

describe("AccessPicker", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    fetchMock.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("should show only what the person has", () => {
    act(() => root.render(<Harness initial={[2]} />));

    expect(host.textContent).toContain("Mandala");
    expect(host.textContent).not.toContain("Guru Yoga");
  });

  it("should say so when the person has nothing", () => {
    act(() => root.render(<Harness initial={[]} />));

    expect(host.textContent).toContain("none");
  });

  it("should only change the form value when removing, without calling the server", () => {
    act(() => root.render(<Harness initial={[1, 2]} />));

    act(() => (host.querySelector('button[aria-label="remove: Guru Yoga"]') as HTMLButtonElement).click());

    expect(value).toEqual([2]);
    expect(host.textContent).not.toContain("Guru Yoga");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should still show an id it has no name for, so it can be removed", () => {
    act(() => root.render(<Harness initial={[99]} />));

    expect(host.textContent).toContain("#99");
  });
});

describe("eventOption", () => {
  it("should use the Portuguese title when the admin is in Portuguese", () => {
    const option = eventOption({ id: 1, titleEn: "Spring", titlePt: "Primavera", eventCode: "C1" }, "pt");

    expect(option.label).toBe("Primavera");
    expect(option.detail).toBe("C1");
  });

  it("should fall back to the English title when there is no Portuguese one", () => {
    expect(eventOption({ id: 1, titleEn: "Spring" }, "pt").label).toBe("Spring");
  });
});
