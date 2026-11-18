/**
 * Main teachers / intro / guests: two pickers editing one ordered list, the intro
 * select between them, and a preview of how the app will read.
 */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", async () => {
  const { en } = await import("../i18n/en");
  const lookup = (key: string): string => {
    const value = key.split(".").reduce<unknown>((node, k) => (node as Record<string, unknown>)?.[k], en);
    return typeof value === "string" ? value : key;
  };
  return { useTranslate: () => lookup };
});

import {
  EventTeachersFields,
  orderedEventTeacherIds,
  teacherIdsPayload,
  type GuestIntro,
  type TeacherPick,
} from "./EventTeachersFields";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JKR = { id: 1, name: "Jigme Khyentse Rinpoche", abbreviation: "JKR" };
const PWR = { id: 2, name: "Pema Wangyal Rinpoche", abbreviation: "PWR" };
const SRR = { id: 3, name: "Shechen Rabjam Rinpoche", abbreviation: "SRR" };
const ALL = [JKR, PWR, SRR];

let state: { selected: TeacherPick[]; guestIds: number[]; guestIntro: GuestIntro | null };

const Harness = ({ initial }: { initial: typeof state }) => {
  const [s, setS] = useState(initial);
  state = s;
  return (
    <EventTeachersFields
      allTeachers={ALL}
      selected={s.selected}
      guestIds={s.guestIds}
      guestIntro={s.guestIntro}
      onChange={(next) => setS((p) => ({ ...p, ...next }))}
      onGuestIntroChange={(guestIntro) => setS((p) => ({ ...p, guestIntro }))}
    />
  );
};

const options = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
const optionNamed = (label: string): HTMLElement => {
  const found = options().find((o) => o.textContent === label);
  if (!found) throw new Error(`no option ${label} in ${options().map((o) => o.textContent).join(" / ")}`);
  return found;
};
const openPicker = (host: HTMLElement, label: string) => {
  const field = [...host.querySelectorAll("label")].find((l) => l.textContent === label)!.parentElement!;
  const input = field.querySelector("input") as HTMLInputElement;
  act(() => {
    input.focus();
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("EventTeachersFields", () => {
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

  it("should show a main teachers picker, an intro select and a guests picker", () => {
    act(() => root.render(<Harness initial={{ selected: [], guestIds: [], guestIntro: null }} />));

    const labels = [...host.querySelectorAll("label")].map((l) => l.textContent);
    expect(labels).toEqual(["Main teachers", "Intro", "Guests / other teachers"]);
  });

  it("should preview the main teachers and the guest line the way the app reads", () => {
    act(() =>
      root.render(<Harness initial={{ selected: [JKR, PWR, SRR], guestIds: [3], guestIntro: "with_presence_of" }} />),
    );

    const preview = host.querySelector('[data-testid="teachers-preview"]')!;
    expect(preview.textContent).toContain("Jigme Khyentse Rinpoche, Pema Wangyal Rinpoche");
    expect(preview.textContent).toContain("with the presence of Shechen Rabjam Rinpoche");
  });

  it("should use the default phrase in the preview when no intro is chosen", () => {
    act(() => root.render(<Harness initial={{ selected: [JKR, SRR], guestIds: [3], guestIntro: null }} />));

    expect(host.querySelector('[data-testid="teachers-preview"]')!.textContent).toContain(
      "with the presence of Shechen Rabjam Rinpoche",
    );
  });

  it("should add a guest after the main teachers and mark it as a guest", () => {
    act(() => root.render(<Harness initial={{ selected: [JKR, PWR], guestIds: [], guestIntro: null }} />));

    openPicker(host, "Guests / other teachers");
    act(() => optionNamed("Shechen Rabjam Rinpoche (SRR)").click());

    expect(state.selected.map((t) => t.id)).toEqual([1, 2, 3]);
    expect(state.guestIds).toEqual([3]);
  });

  it("should not offer a main teacher in the guests picker", () => {
    act(() => root.render(<Harness initial={{ selected: [JKR], guestIds: [], guestIntro: null }} />));

    openPicker(host, "Guests / other teachers");

    expect(options().map((o) => o.textContent)).toEqual(["Pema Wangyal Rinpoche (PWR)", "Shechen Rabjam Rinpoche (SRR)"]);
  });
});

describe("teacherIdsPayload", () => {
  it("should send the main teachers first then the guests, each in the order picked", () => {
    expect(teacherIdsPayload([SRR, PWR, JKR], [3])).toEqual([
      { id: 2, role: "teacher" },
      { id: 1, role: "teacher" },
      { id: 3, role: "guest" },
    ]);
  });
});

describe("orderedEventTeacherIds", () => {
  it("should load the saved order, main teachers before guests", () => {
    expect(
      orderedEventTeacherIds([
        { teacherId: 3, role: "guest", position: 2 },
        { teacherId: 2, role: "teacher", position: 1 },
        { teacherId: 1, role: "teacher", position: 0 },
      ]),
    ).toEqual([1, 2, 3]);
  });
});
