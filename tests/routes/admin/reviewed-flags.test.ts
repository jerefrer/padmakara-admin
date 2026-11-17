/**
 * Sofia approved the AI-written titles of event 928 one by one; André later
 * found three of them pending again. A save built from a page opened before
 * the approvals still carries `titlePtReviewed: false` with the unchanged
 * title, and the routes wrote it straight back. An approval may now only be
 * withdrawn by a write that also changes the text it approved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const { mockDb, updatedSets, stored } = vi.hoisted(() => {
  const updatedSets: Record<string, unknown>[] = [];
  const stored: Record<string, Record<string, unknown>> = {};
  const findFirst = (table: string) => vi.fn(() => Promise.resolve(structuredClone(stored[table] ?? null)));
  const mockDb = {
    query: {
      tracks: { findFirst: findFirst("tracks") },
      sessions: { findFirst: findFirst("sessions") },
      eventVideos: { findFirst: findFirst("eventVideos") },
      events: { findFirst: findFirst("events") },
    },
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })),
    update: vi.fn(() => ({
      set: vi.fn((data: Record<string, unknown>) => {
        updatedSets.push(data);
        const where = () => Object.assign(Promise.resolve([]), {
          returning: vi.fn(() => Promise.resolve([{ id: 7, sessionId: 3, eventId: 928, s3Key: null, ...data }])),
        });
        return { where: vi.fn(where) };
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn(() => Promise.resolve()) })) })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
  };
  return { mockDb, updatedSets, stored };
});

vi.mock("../../../src/db/index.ts", () => ({ db: mockDb }));
vi.mock("../../../src/services/sync-versions.ts", () => ({ bumpVersion: vi.fn(() => Promise.resolve()) }));

import { createAccessToken } from "../../../src/services/auth.ts";

const auth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});

const send = async (path: string, method: string, body: Record<string, unknown>) =>
  testJson(path, { method, headers: await auth(), body: JSON.stringify(body) });

/** The write the route made to the row itself (later sets only touch the parent event). */
const rowWrite = () => updatedSets[0]!;

beforeEach(() => {
  vi.clearAllMocks();
  updatedSets.length = 0;
  for (const key of Object.keys(stored)) delete stored[key];
  stored.tracks = {
    id: 7, sessionId: 3, title: "Refúgio", titleEn: "Refuge", titlePt: "Refúgio",
    titleEnReviewed: true, titlePtReviewed: true,
  };
  stored.sessions = { id: 3, eventId: 928, titleEn: "Day 1", titlePt: "Dia 1", titleEnReviewed: true, titlePtReviewed: true };
  stored.eventVideos = { id: 7, eventId: 928, titleEn: "Video", titlePt: "Vídeo", titleEnReviewed: true, titlePtReviewed: true };
  stored.events = {
    id: 928, eventCode: "20260914_16-JKR-PWR-PP1-ZOOM", eventCodeReviewed: true,
    titleEn: "Refuge & Bodhicitta", titlePt: "Refúgio e Bodhicitta",
    titleEnReviewed: true, titlePtReviewed: true,
    mainThemesEn: "Refuge", mainThemesPt: "Refúgio", mainThemesEnReviewed: true, mainThemesPtReviewed: true,
    sessionThemesEn: "", sessionThemesPt: "", sessionThemesEnReviewed: true, sessionThemesPtReviewed: true,
    bibliography: null, bibliographyPt: null, bibliographyEnReviewed: true, bibliographyPtReviewed: true,
    status: "draft", featuredAt: null,
    eventTeachers: [], eventRetreatGroups: [], eventPlaces: [], eventPublications: [], eventOrganizers: [],
  };
});

describe("PUT /api/admin/tracks/:id reviewed flags", () => {
  it("should keep an approval when a stale save sends the flag false with the same title", async () => {
    const { status } = await send("/api/admin/tracks/7", "PUT", {
      title: "Refuge", titleEn: "Refuge", titlePt: "Refúgio", titleEnReviewed: true, titlePtReviewed: false, speaker: "JKR",
    });
    expect(status).toBe(200);
    expect(rowWrite()).not.toHaveProperty("titlePtReviewed");
    expect(rowWrite()).toMatchObject({ speaker: "JKR" });
  });

  it("should keep an approval when the flag is sent false without any title", async () => {
    await send("/api/admin/tracks/7", "PUT", { titlePtReviewed: false });
    expect(rowWrite()).not.toHaveProperty("titlePtReviewed");
  });

  it("should flag a title again when the same write puts new text in it", async () => {
    await send("/api/admin/tracks/7", "PUT", { titlePt: "Refúgio e Bodhicitta", titlePtReviewed: false });
    expect(rowWrite()).toMatchObject({ titlePt: "Refúgio e Bodhicitta", titlePtReviewed: false });
  });

  it("should store an approval", async () => {
    stored.tracks!.titlePtReviewed = false;
    await send("/api/admin/tracks/7", "PUT", { titlePtReviewed: true });
    expect(rowWrite()).toMatchObject({ titlePtReviewed: true });
  });
});

describe("PUT /api/admin/sessions/:id reviewed flags", () => {
  it("should keep an approval when a stale save sends the flag false with the same title", async () => {
    await send("/api/admin/sessions/3", "PUT", { titleEn: "Day 1", titleEnReviewed: false });
    expect(rowWrite()).not.toHaveProperty("titleEnReviewed");
  });

  it("should flag a title again when the same write puts new text in it", async () => {
    await send("/api/admin/sessions/3", "PUT", { titleEn: "Day one", titleEnReviewed: false });
    expect(rowWrite()).toMatchObject({ titleEn: "Day one", titleEnReviewed: false });
  });
});

describe("PATCH /api/admin/videos/:id reviewed flags", () => {
  it("should keep an approval when a stale save sends the flag false with the same title", async () => {
    await send("/api/admin/videos/7", "PATCH", { titlePt: "Vídeo", titlePtReviewed: false });
    expect(rowWrite()).not.toHaveProperty("titlePtReviewed");
  });

  it("should flag a title again when the same write puts new text in it", async () => {
    await send("/api/admin/videos/7", "PATCH", { titlePt: "Vídeo 1", titlePtReviewed: false });
    expect(rowWrite()).toMatchObject({ titlePtReviewed: false });
  });
});

describe("PUT /api/admin/events/:id reviewed flags", () => {
  it("should keep every approval when a stale form sends the flags false with the same texts", async () => {
    const { status } = await send("/api/admin/events/928", "PUT", {
      eventCode: "20260914_16-JKR-PWR-PP1-ZOOM", eventCodeReviewed: false,
      titleEn: "Refuge & Bodhicitta", titleEnReviewed: false,
      titlePt: "Refúgio e Bodhicitta", titlePtReviewed: false,
      mainThemesEn: "Refuge", mainThemesEnReviewed: false,
      mainThemesPt: "Refúgio", mainThemesPtReviewed: false,
      sessionThemesEn: "", sessionThemesEnReviewed: false,
      sessionThemesPt: "", sessionThemesPtReviewed: false,
      bibliography: null, bibliographyEnReviewed: false,
      bibliographyPt: null, bibliographyPtReviewed: false,
    });
    expect(status).toBe(200);
    for (const flag of [
      "eventCodeReviewed", "titleEnReviewed", "titlePtReviewed", "mainThemesEnReviewed", "mainThemesPtReviewed",
      "sessionThemesEnReviewed", "sessionThemesPtReviewed", "bibliographyEnReviewed", "bibliographyPtReviewed",
    ]) {
      expect(rowWrite()).not.toHaveProperty(flag);
    }
  });

  it("should flag a field again when the same save puts new text in it", async () => {
    await send("/api/admin/events/928", "PUT", { mainThemesPt: "Refúgio; bodhicitta", mainThemesPtReviewed: false });
    expect(rowWrite()).toMatchObject({ mainThemesPt: "Refúgio; bodhicitta", mainThemesPtReviewed: false });
  });
});
