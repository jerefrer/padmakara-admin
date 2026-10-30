import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";
import { BUILTIN_LOGO_KEY } from "../../../src/lib/slides/defaults.ts";
import { ANDRE_EVENT, EMPTY_EVENT, slideLines } from "./slide-fixtures.ts";

// ─── Mocks (must come before route imports) ──────────────────────────────
//
// POST /api/admin/events/:id/slides/defaults is event-scoped (no
// event_video row involved) — only db.query.events.findFirst is needed.
// Mirrors the video-scoped equivalent's tests in
// tests/routes/admin/video-slides.test.ts, since both routes share their
// metadata assembly via src/services/slide-metadata.ts.

vi.mock("../../../src/db/index.ts", () => {
  const mockFindFirstEvent = vi.fn(() => Promise.resolve(null));
  return {
    db: {
      query: {
        events: { findFirst: mockFindFirstEvent },
      },
      _findFirstEvent: mockFindFirstEvent,
    },
  };
});

import { db } from "../../../src/db/index.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const mockFindFirstEvent = (db as any)._findFirstEvent as ReturnType<typeof vi.fn>;

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

describe("POST /api/admin/events/:id/slides/defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generates the English intro + builtin-logo outro from full event metadata", async () => {
    mockFindFirstEvent.mockResolvedValueOnce(ANDRE_EVENT);

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/7/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-10-10" }),
    });

    expect(status).toBe(200);
    expect(body.language).toBe("en");
    expect(body.missing).toEqual([]);
    expect(body.slides.intro.map(slideLines)).toEqual([
      ["", "Padmakara"],
      ["Jigme Khyentse Rinpoche"],
      ["Jigme Khyentse Rinpoche", "", "", "Learning to let go and enjoying space", "", "", ""],
      ["October 2026", "Lisbon, Portugal"],
      ["Session 1 of 4", "10 October 2026, morning"],
      ["Event organized by", "Fundação Kangyur Rinpoche", "", "Video Production", "Padmakara Portugal"],
    ]);
    expect(body.slides.outro).toHaveLength(1);
    expect(body.slides.outro[0].lines[0]).toMatchObject({ type: "image", s3Key: BUILTIN_LOGO_KEY });
  });

  it("reports the session as missing when the draft has no recording date to match it with", async () => {
    mockFindFirstEvent.mockResolvedValueOnce(ANDRE_EVENT);

    const token = await adminToken();
    const { body } = await testJson("/api/admin/events/7/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(body.missing).toEqual(["session"]);
    expect(body.slides.intro).toHaveLength(5);
  });

  it("generates the Portuguese intro when lang is pt", async () => {
    mockFindFirstEvent.mockResolvedValueOnce(ANDRE_EVENT);

    const token = await adminToken();
    const { body } = await testJson("/api/admin/events/7/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ lang: "pt", date: "2026-10-10" }),
    });

    expect(body.language).toBe("pt");
    expect(body.slides.intro.map(slideLines).slice(3)).toEqual([
      ["Outubro 2026", "Lisbon, Portugal"],
      ["Sessão 1 de 4", "10 de outubro de 2026, manhã"],
      ["Evento organizado por", "Fundação Kangyur Rinpoche", "", "Produção de vídeo", "Padmakara Portugal"],
    ]);
  });

  it("falls back to English for an unknown lang and for a Tibetan event", async () => {
    mockFindFirstEvent.mockResolvedValueOnce({ ...ANDRE_EVENT, originalLanguage: "tib" });

    const token = await adminToken();
    const { body } = await testJson("/api/admin/events/7/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ lang: "xx" }),
    });

    expect(body.language).toBe("en");
  });

  it("joins several organizers in their chosen order, not the order the database returned them", async () => {
    mockFindFirstEvent.mockResolvedValueOnce({
      ...EMPTY_EVENT,
      eventOrganizers: [
        { position: 1, organizer: { id: 2, name: "Fundação Kangyur Rinpoche", abbreviation: null } },
        { position: 0, organizer: { id: 1, name: "Casa da Cultura do Tibete", abbreviation: null } },
      ],
    });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/7/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(JSON.stringify(body.slides.intro)).toContain("Casa da Cultura do Tibete · Fundação Kangyur Rinpoche");
  });

  it("falls back to the event's startDate for the month and year — there is no video yet to prefer", async () => {
    mockFindFirstEvent.mockResolvedValueOnce({ ...EMPTY_EVENT, startDate: "2017-01-02" });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/7/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.slides.intro.map(slideLines)).toEqual([["", "Padmakara"], ["Retreat"], ["January 2017"]]);
  });

  it("returns every missing input when the event has nothing to draw on, and still the logo slide and outro", async () => {
    mockFindFirstEvent.mockResolvedValueOnce({ ...EMPTY_EVENT, titleEn: "" });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/8/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.missing).toEqual(["teacher", "title", "date", "place", "session", "organizer", "production"]);
    expect(body.slides.intro.map(slideLines)).toEqual([["", "Padmakara"]]);
    expect(body.slides.outro[0].lines[0].s3Key).toBe(BUILTIN_LOGO_KEY);
  });

  it("returns 404 when the event does not exist", async () => {
    mockFindFirstEvent.mockResolvedValueOnce(null);

    const token = await adminToken();
    const { status } = await testJson("/api/admin/events/999/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(404);
  });

  it("returns 401 without an auth token", async () => {
    const { status } = await testJson("/api/admin/events/7/slides/defaults", {
      method: "POST",
    });
    expect(status).toBe(401);
  });
});
