import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";
import { BUILTIN_LOGO_KEY } from "../../../src/lib/slides/defaults.ts";

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

  it("generates the expected 5-slide intro + builtin-logo outro from full event metadata", async () => {
    mockFindFirstEvent.mockResolvedValueOnce({
      id: 7,
      startDate: "2016-06-18",
      organizer: "Padmakara Portugal",
      creditLines: ["Filmagem, arquivo e edição"],
      copyrightHolder: "Padmakara",
      eventType: { nameEn: "Teachings", namePt: "Ensinamentos" },
      eventTeachers: [{ teacher: { name: "Jigme Khyentse Rinpoche" } }],
      eventPlaces: [{ place: { name: "CCA", location: "Loulé, Portugal" } }],
    });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/7/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    expect(body.slides.intro).toHaveLength(5);
    expect(body.slides.intro[0].lines[0].spans[0].text).toBe("Jigme Khyentse Rinpoche");
    expect(body.slides.outro).toHaveLength(1);
    expect(body.slides.outro[0].lines).toHaveLength(1);
    expect(body.slides.outro[0].lines[0]).toMatchObject({
      type: "image",
      s3Key: BUILTIN_LOGO_KEY,
    });
  });

  it("falls back to the event's startDate for the date slide — there is no video yet to prefer", async () => {
    mockFindFirstEvent.mockResolvedValueOnce({
      id: 7,
      startDate: "2017-01-02",
      organizer: null,
      creditLines: [],
      copyrightHolder: null,
      eventType: null,
      eventTeachers: [],
      eventPlaces: [],
    });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/7/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    // Only the date slide can exist here (no teacher/type/organizer/credits).
    expect(body.slides.intro).toHaveLength(1);
    expect(body.slides.intro[0].lines[0].spans[0].text).toBe("2 January 2017");
  });

  it("omits slides whose backing data is missing, but always keeps the builtin outro", async () => {
    mockFindFirstEvent.mockResolvedValueOnce({
      id: 8,
      startDate: null,
      organizer: null,
      creditLines: [],
      copyrightHolder: null,
      eventType: null,
      eventTeachers: [{ teacher: { name: "Jigme Khyentse Rinpoche" } }],
      eventPlaces: [],
    });

    const token = await adminToken();
    const { status, body } = await testJson("/api/admin/events/8/slides/defaults", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(status).toBe(200);
    // Only the teacher slide survives: no event type, no date, no
    // organizer/place, no credits/copyright.
    expect(body.slides.intro).toHaveLength(1);
    expect(body.slides.intro[0].lines[0].spans[0].text).toBe("Jigme Khyentse Rinpoche");
    expect(body.slides.outro).toHaveLength(1);
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
