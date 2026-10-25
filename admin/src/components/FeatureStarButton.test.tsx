/**
 * The highlight star shared by the events list, the edit form and the event
 * page. Mounted with react-dom directly, like the other component tests here.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const getList = vi.hoisted(() => vi.fn());
vi.mock("../utils/authFetch", () => ({ authFetch }));
vi.mock("react-admin", () => ({
  useTranslate: () => (key: string, opts?: Record<string, string>) =>
    opts ? `${key}|${Object.values(opts).join("|")}` : key,
  useNotify: () => notify,
  useRefresh: () => refresh,
  useDataProvider: () => ({ getList }),
}));

import { FeatureStarButton } from "./FeatureStarButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const render = (props: Partial<React.ComponentProps<typeof FeatureStarButton>> = {}) =>
  act(() =>
    root.render(
      <FeatureStarButton eventId={5} status="published" featured={false} title="New one" {...props} />,
    ),
  );

const starButton = () => container.querySelector("button") as HTMLButtonElement;
const dialogButton = (label: string) =>
  [...document.body.querySelectorAll("[role=dialog] button")].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;

beforeEach(() => {
  authFetch.mockReset();
  notify.mockReset();
  refresh.mockReset();
  getList.mockReset();
  getList.mockResolvedValue({ data: [{ id: 9, titleEn: "Old one", featuredAt: "2026-01-01T00:00:00Z" }] });
  authFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 5, featuredAt: "2026-10-25T00:00:00Z" }) });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("FeatureStarButton", () => {
  it("should disable the star when the event already holds the highlight", () => {
    render({ featured: true });
    expect(starButton().disabled).toBe(true);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("should disable the star when the event is not published", () => {
    render({ status: "draft" });
    expect(starButton().disabled).toBe(true);
  });

  it("should name the current highlight in the dialog when another event holds it", async () => {
    render();
    await act(async () => starButton().click());
    expect(document.body.textContent).toContain("padmakara.events.featuredDialogMove|Old one|New one");
  });

  it("should ask without naming a current highlight when none exists", async () => {
    getList.mockResolvedValue({ data: [{ id: 9, titleEn: "Draft", featuredAt: null }] });
    render();
    await act(async () => starButton().click());
    expect(document.body.textContent).toContain("padmakara.events.featuredDialogSet|New one");
  });

  it("should call the feature endpoint and refresh when the dialog is confirmed", async () => {
    const onFeatured = vi.fn();
    render({ onFeatured });
    await act(async () => starButton().click());
    await act(async () => dialogButton("padmakara.events.featuredDialogConfirm").click());

    expect(authFetch).toHaveBeenCalledWith("/api/admin/events/5/feature", { method: "POST" });
    expect(notify).toHaveBeenCalledWith("padmakara.events.featuredSetNotify", { type: "success" });
    expect(onFeatured).toHaveBeenCalledWith({ id: 5, featuredAt: "2026-10-25T00:00:00Z" });
    expect(refresh).toHaveBeenCalled();
  });

  it("should not call the endpoint when the dialog is cancelled", async () => {
    render();
    await act(async () => starButton().click());
    await act(async () => dialogButton("padmakara.events.cancel").click());

    expect(authFetch).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("should notify the mapped message when the server refuses with EVENT_NOT_PUBLISHED", async () => {
    authFetch.mockResolvedValue({ ok: false, status: 409, json: () => Promise.resolve({ code: "EVENT_NOT_PUBLISHED" }) });
    render();
    await act(async () => starButton().click());
    await act(async () => dialogButton("padmakara.events.featuredDialogConfirm").click());

    expect(notify).toHaveBeenCalledWith(
      "padmakara.events.featuredNotPublished",
      expect.objectContaining({ type: "error" }),
    );
  });
});
