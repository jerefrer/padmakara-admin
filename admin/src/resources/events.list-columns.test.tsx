/** The events list: a compact numeric Dates column and an Announced column. */

import { Children, cloneElement, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RECORDS = [
  { id: 1, eventCode: "A", startDate: "2026-09-18", endDate: "2026-09-20", lastAnnouncedAt: new Date(2026, 10, 13, 12).toISOString() },
  { id: 2, eventCode: "B", startDate: "2026-09-18", endDate: "2026-10-02", lastAnnouncedAt: null },
  { id: 3, eventCode: "C", startDate: "2026-09-18", endDate: "2026-09-18", lastAnnouncedAt: null },
];

// A minimal list: rows of the records, each FunctionField rendering a labelled cell.
vi.mock("react-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-admin")>();
  return {
    ...actual,
    useTranslate: () => (key: string) => key,
    useLocaleState: () => ["en", vi.fn()],
    List: ({ children }: { children: ReactElement }) => children,
    Datagrid: ({ children }: { children: ReactElement[] }) => (
      <table>
        <tbody>
          {RECORDS.map((record) => (
            <tr key={record.id}>{Children.map(children, (child) => child && cloneElement(child as ReactElement<{ record: unknown }>, { record }))}</tr>
          ))}
        </tbody>
      </table>
    ),
    FunctionField: ({ label, sortBy, render, record }: any) => (
      <td data-label={label} data-sort={sortBy}>{render(record)}</td>
    ),
    ReferenceArrayField: () => null,
  };
});

vi.mock("../components/FeatureStarButton", () => ({ FeatureStarButton: () => <button /> }));

import { EventList } from "./events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("EventList date columns", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<EventList />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const cells = (label: string) =>
    Array.from(host.querySelectorAll(`td[data-label="${label}"]`)).map((td) => td.textContent);

  it("should show the dates as compact numbers", () => {
    expect(cells("padmakara.events.dates")).toEqual(["18–20/09/2026", "18/09–02/10/2026", "18/09/2026"]);
  });

  it("should show the last announcement as dd/mm/yyyy, or a dash when none", () => {
    expect(cells("padmakara.events.announced")).toEqual(["13/11/2026", "—", "—"]);
  });

  it("should sort the Announced column by the last announcement", () => {
    const td = host.querySelector('td[data-label="padmakara.events.announced"]');
    expect(td!.getAttribute("data-sort")).toBe("lastAnnouncedAt");
  });
});
