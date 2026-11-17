/**
 * The AI assistant's apply marked the event and session titles it wrote as
 * approved, while the track and video titles it wrote stayed pending. Every
 * text the AI writes now waits for a person to approve it.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import { CoreAdminContext, type DataProvider } from "react-admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAssistResult } from "../components/AiAssistPanel";

vi.mock("../utils/authFetch", () => ({
  authFetch: vi.fn(async () => new Response("{}", { status: 404 })),
}));

// The panel itself talks to the model; the test only needs its apply callback.
const panel = vi.hoisted(() => ({ onApply: null as ((r: AiAssistResult) => void | Promise<void>) | null }));
vi.mock("../components/AiAssistPanel", () => ({
  AiAssistPanel: (props: { onApply: (r: AiAssistResult) => void | Promise<void> }) => {
    panel.onApply = props.onApply;
    return null;
  },
}));

import { EventEdit } from "./events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  panel.onApply = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const EVENT_ID = 7;
const SESSION_ID = 31;
const EVENT = {
  id: EVENT_ID,
  eventCode: "2026-04-RET",
  titleEn: "Spring retreat",
  titlePt: "Retiro de primavera",
  titleEnReviewed: true,
  titlePtReviewed: true,
  mainThemesEn: "Old",
  mainThemesPt: "Antigo",
  sessionThemesEn: "Old",
  sessionThemesPt: "Antigo",
  mainThemesEnReviewed: true,
  mainThemesPtReviewed: true,
  sessionThemesEnReviewed: true,
  sessionThemesPtReviewed: true,
  status: "draft",
  sessions: [
    {
      id: SESSION_ID,
      sessionNumber: 1,
      sessionDate: "2026-04-10",
      timePeriod: "morning",
      titleEn: "Day 1",
      titlePt: "Dia 1",
      titleEnReviewed: true,
      titlePtReviewed: true,
      tracks: [{ id: 9, trackNumber: 1, title: "Refuge", titleEn: "Refuge", titlePt: "Refúgio", s3Key: "k" }],
    },
  ],
  videos: [],
  transcripts: [],
  eventTeachers: [],
  eventPlaces: [],
  eventRetreatGroups: [],
  organizers: [],
  internalNotes: "",
};

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});

async function open() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const update = vi.fn(async (_resource: string, params: { data: unknown }) => ({ data: params.data }));
  const dataProvider = {
    getList: vi.fn(async () => ({ data: [], total: 0 })),
    getOne: vi.fn(async () => ({ data: structuredClone(EVENT) })),
    update,
  } as unknown as DataProvider;
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[`/events/${EVENT_ID}`]}>
        <CoreAdminContext dataProvider={dataProvider} queryClient={queryClient}>
          <Routes>
            <Route path="/events/:id" element={<EventEdit />} />
          </Routes>
        </CoreAdminContext>
      </MemoryRouter>,
    ),
  );
  await flush();
  return { update };
}

const apply = (result: Partial<AiAssistResult>) =>
  act(async () => {
    await panel.onApply!({ sessions: [], tracks: [], videos: [], ...result } as AiAssistResult);
  });

const clickSave = async () => {
  const save = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("padmakara.events.saveChanges"),
  ) as HTMLButtonElement;
  await act(async () => save.click());
  await flush();
};

const dataSentTo = (update: ReturnType<typeof vi.fn>, resource: string) =>
  update.mock.calls.filter(([r]) => r === resource).map(([, params]) => (params as { data: Record<string, unknown> }).data);

describe("EventEdit AI apply and approvals", () => {
  it("should leave AI-written session titles pending approval", async () => {
    const { update } = await open();
    await apply({ sessions: [{ rowKey: String(SESSION_ID), titleEn: "First day", titlePt: "Primeiro dia" }] });

    expect(dataSentTo(update, "sessions")).toEqual([
      { titleEn: "First day", titleEnReviewed: false, titlePt: "Primeiro dia", titlePtReviewed: false },
    ]);
  });

  it("should leave AI-written event titles pending approval when the event is saved", async () => {
    const { update } = await open();
    await apply({ event: { titleEn: "Spring retreat on refuge", titlePt: "Retiro de primavera sobre o refúgio" } });
    await clickSave();

    const [sent] = dataSentTo(update, "events");
    expect(sent).toMatchObject({
      titleEn: "Spring retreat on refuge",
      titleEnReviewed: false,
      titlePt: "Retiro de primavera sobre o refúgio",
      titlePtReviewed: false,
    });
  });

  it("should leave AI-written main and session themes pending approval when the event is saved", async () => {
    const { update } = await open();
    await apply({
      event: {
        mainThemesEn: "Refuge and bodhicitta",
        mainThemesPt: "Refúgio e bodhicitta",
        sessionThemesEn: "Day by day",
        sessionThemesPt: "Dia a dia",
      },
    });
    await clickSave();

    const [sent] = dataSentTo(update, "events");
    expect(sent).toMatchObject({
      mainThemesEnReviewed: false,
      mainThemesPtReviewed: false,
      sessionThemesEnReviewed: false,
      sessionThemesPtReviewed: false,
    });
  });

  it("should not touch the theme flags when the AI wrote no theme", async () => {
    const { update } = await open();
    await apply({ event: { titleEn: "Spring retreat on refuge" } });
    await clickSave();

    const [sent] = dataSentTo(update, "events");
    expect(sent).not.toHaveProperty("mainThemesEnReviewed");
    expect(sent).not.toHaveProperty("sessionThemesPtReviewed");
  });
});
