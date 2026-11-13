/** "Announce new content": button only when published; dialog states, default ticks and POST body. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-admin", () => ({
  useTranslate: () => (key: string) => key,
}));

import { AnnounceContentButton } from "./AnnounceContentButton";
import type { AnnouncementsInfo } from "../utils/announce";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO: AnnouncementsInfo = {
  recipients: 12,
  published: { at: "2026-11-13T10:00:00.000Z", count: 4 },
  kinds: [
    { kind: "transcripts", available: true, announcedAt: null },
    { kind: "videos", available: false, reason: "hidden", announcedAt: null },
    { kind: "texts", available: true, announcedAt: "2026-11-10T10:00:00.000Z" },
  ],
  history: [{ kinds: ["texts"], sentAt: "2026-11-10T10:00:00.000Z", count: 9, message: null }],
};

describe("AnnounceContentButton", () => {
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

  const flush = () => act(async () => { await Promise.resolve(); });
  const open = async (props: Partial<Parameters<typeof AnnounceContentButton>[0]> = {}) => {
    const load = vi.fn(() => Promise.resolve(INFO));
    const onConfirm = vi.fn();
    act(() => root.render(<AnnounceContentButton status="published" load={load} onConfirm={onConfirm} {...props} />));
    act(() => (host.querySelector('[data-testid="announce-open"]') as HTMLButtonElement).click());
    await flush();
    return { load, onConfirm };
  };
  const box = (kind: string) =>
    document.body.querySelector(`input[data-testid="announce-kind-${kind}"]`) as HTMLInputElement;
  const ok = () => document.body.querySelector('[data-testid="confirm-change-ok"]') as HTMLButtonElement;
  const type = (el: HTMLTextAreaElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => { setter.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  };

  it.each(["draft", "forthcoming"])("should not render the button when the event is %s", (status) => {
    act(() => root.render(<AnnounceContentButton status={status} load={() => Promise.resolve(INFO)} onConfirm={() => {}} />));
    expect(host.querySelector('[data-testid="announce-open"]')).toBeNull();
  });

  it("should load the announcements only when the dialog opens", async () => {
    const { load } = await open();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("should tick the available kinds not announced yet and untick the others", async () => {
    await open();
    expect(box("transcripts").checked).toBe(true);
    expect(box("videos").checked).toBe(false);
    expect(box("texts").checked).toBe(false);
  });

  it("should disable a kind that is not available and say why", async () => {
    await open();
    expect(box("videos").disabled).toBe(true);
    expect(box("transcripts").disabled).toBe(false);
    expect(document.body.textContent).toContain("padmakara.events.announceReasonHidden");
  });

  it("should show the empty reason for an empty section", async () => {
    const info = { ...INFO, kinds: [{ kind: "transcripts" as const, available: false, reason: "empty" as const, announcedAt: null }, ...INFO.kinds.slice(1)] };
    await open({ load: () => Promise.resolve(info) });
    expect(document.body.textContent).toContain("padmakara.events.announceReasonEmpty");
  });

  it("should say when a kind was already announced but keep it tickable", async () => {
    await open();
    expect(document.body.textContent).toContain("padmakara.events.announceAlreadyAnnounced");
    expect(box("texts").disabled).toBe(false);
  });

  it("should show the recipient count and the history", async () => {
    await open();
    expect(document.body.textContent).toContain("padmakara.events.announceRecipients");
    expect(document.body.textContent).toContain("padmakara.events.announceHistoryPublished");
    expect(document.body.querySelectorAll('[data-testid="announce-history-item"]')).toHaveLength(1);
  });

  it("should send the ticked kinds without force or message by default", async () => {
    const { onConfirm } = await open();
    act(() => ok().click());
    expect(onConfirm).toHaveBeenCalledWith({ kinds: ["transcripts"] });
  });

  it("should send the trimmed message", async () => {
    const { onConfirm } = await open();
    type(document.body.querySelector('textarea[data-testid="announce-message"]') as HTMLTextAreaElement, "  Enjoy  ");
    act(() => ok().click());
    expect(onConfirm).toHaveBeenCalledWith({ kinds: ["transcripts"], message: "Enjoy" });
  });

  it("should warn and send with force when an announced kind is ticked again", async () => {
    const { onConfirm } = await open();
    expect(document.body.querySelector('[data-testid="announce-resend-warning"]')).toBeNull();
    act(() => box("texts").click());
    expect(document.body.querySelector('[data-testid="announce-resend-warning"]')).not.toBeNull();
    act(() => ok().click());
    expect(onConfirm).toHaveBeenCalledWith({ kinds: ["transcripts", "texts"], force: true });
  });

  it("should disable sending when nothing is ticked", async () => {
    const { onConfirm } = await open();
    act(() => box("transcripts").click());
    expect(ok().disabled).toBe(true);
    act(() => ok().click());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("should close the dialog after confirming", async () => {
    await open();
    act(() => ok().click());
    // The dialog fades out before it unmounts
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });
    expect(document.body.querySelector('[data-testid="announce-kind-transcripts"]')).toBeNull();
  });

  it("should show an error and no boxes when the announcements cannot be loaded", async () => {
    await open({ load: () => Promise.reject(new Error("HTTP 500")) });
    expect(document.body.textContent).toContain("padmakara.events.announceLoadFailed");
    expect(ok().disabled).toBe(true);
  });
});
