import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

// ─── Mock setup (BEFORE imports) ─────────────────────────────────────────

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      events: { findMany: vi.fn() },
      users: { findFirst: vi.fn() },
      // access.ts uses these for group/event attendance checks
      userGroupMemberships: { findFirst: vi.fn().mockResolvedValue(null) },
      userEventAttendance: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  },
}));

import { db } from "../../src/db/index.ts";
import { createAccessToken } from "../../src/services/auth.ts";

// ─── Test data factories ─────────────────────────────────────────────────

function makeEvent(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    eventCode: "2024.04.15-TEST",
    titleEn: "Spring Retreat 2024",
    titlePt: "Retiro de Primavera 2024",
    mainThemesEn: "Compassion and wisdom",
    mainThemesPt: "Compaixao e sabedoria",
    sessionThemesEn: "Bodhicitta, emptiness, meditation",
    sessionThemesPt: "Bodhicitta, vacuidade, meditacao",
    startDate: "2024-04-15",
    endDate: "2024-04-20",
    status: "published",
    audienceId: 1,
    audience: { slug: "free-anyone" },
    eventTeachers: [
      { teacher: { name: "Jigme Khyentse Rinpoche" } },
    ],
    eventRetreatGroups: [
      { retreatGroup: { id: 1, name: "Group A" } },
    ],
    sessions: [
      {
        id: 10,
        titleEn: "Morning meditation",
        titlePt: "Meditacao da manha",
        sessionDate: "2024-04-15",
        timePeriod: "morning",
        sessionNumber: 1,
        tracks: [
          { id: 100, title: "Introduction to bodhicitta", trackNumber: 1, speaker: "JKR" },
          { id: 101, title: "Guided meditation", trackNumber: 2, speaker: "JKR" },
        ],
      },
      {
        id: 11,
        titleEn: "Evening teaching",
        titlePt: "Ensinamento da noite",
        sessionDate: "2024-04-15",
        timePeriod: "evening",
        sessionNumber: 2,
        tracks: [
          { id: 102, title: "The nature of emptiness", trackNumber: 1, speaker: "JKR" },
        ],
      },
    ],
    ...overrides,
  };
}

function makePrivateEvent(overrides: Record<string, any> = {}) {
  return makeEvent({
    id: 2,
    eventCode: "2024.10.01-PRIVATE",
    titleEn: "Autumn Retreat 2024",
    titlePt: "Retiro de Outono 2024",
    audience: { slug: "free-subscribers" },
    ...overrides,
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("GET /api/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Validation", () => {
    it("returns 400 when query is missing", async () => {
      const { status, body } = await testJson("/api/search");

      expect(status).toBe(400);
      expect(body.code).toBe("QUERY_TOO_SHORT");
    });

    it("returns 400 when query is too short (1 char)", async () => {
      const { status, body } = await testJson("/api/search?q=a");

      expect(status).toBe(400);
      expect(body.code).toBe("QUERY_TOO_SHORT");
    });

    it("returns 400 when query is only whitespace", async () => {
      const { status, body } = await testJson("/api/search?q=%20%20");

      expect(status).toBe(400);
      expect(body.code).toBe("QUERY_TOO_SHORT");
    });

    it("accepts query with exactly 2 characters", async () => {
      (db.query.events.findMany as any).mockResolvedValue([]);

      const { status, body } = await testJson("/api/search?q=om");

      expect(status).toBe(200);
      expect(body.query).toBe("om");
    });
  });

  describe("Unauthenticated search (public events only)", () => {
    it("returns matching public events", async () => {
      const publicEvent = makeEvent();
      (db.query.events.findMany as any).mockResolvedValue([publicEvent]);

      const { status, body } = await testJson("/api/search?q=bodhicitta");

      expect(status).toBe(200);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].event.id).toBe(1);
      expect(body.totalResults).toBe(1);
      expect(body.query).toBe("bodhicitta");
    });

    it("excludes non-public events for unauthenticated users", async () => {
      const publicEvent = makeEvent();
      const privateEvent = makePrivateEvent();
      (db.query.events.findMany as any).mockResolvedValue([publicEvent, privateEvent]);

      const { status, body } = await testJson("/api/search?q=retreat");

      expect(status).toBe(200);
      // Only the public event should appear (title matches "retreat")
      expect(body.results).toHaveLength(1);
      expect(body.results[0].event.id).toBe(1);
    });

    it("returns empty results when no match", async () => {
      const publicEvent = makeEvent();
      (db.query.events.findMany as any).mockResolvedValue([publicEvent]);

      const { status, body } = await testJson("/api/search?q=xyznonexistent");

      expect(status).toBe(200);
      expect(body.results).toHaveLength(0);
      expect(body.totalResults).toBe(0);
    });
  });

  describe("Authenticated search", () => {
    it("returns results filtered by access control for authenticated users", async () => {
      const publicEvent = makeEvent();
      const subscriberEvent = makePrivateEvent();
      (db.query.events.findMany as any).mockResolvedValue([publicEvent, subscriberEvent]);

      // Mock user lookup (user without active subscription)
      (db.query.users.findFirst as any).mockResolvedValue({
        id: 1,
        role: "user",
        subscriptionStatus: "none",
        subscriptionExpiresAt: null,
      });

      const token = await createAccessToken({
        sub: 1,
        email: "user@test.com",
        role: "user",
      });

      const { status, body } = await testJson("/api/search?q=retreat", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(status).toBe(200);
      // Non-subscriber should only see public event
      expect(body.results).toHaveLength(1);
      expect(body.results[0].event.id).toBe(1);
    });

    it("admin users see all published events", async () => {
      const publicEvent = makeEvent();
      const privateEvent = makePrivateEvent();
      (db.query.events.findMany as any).mockResolvedValue([publicEvent, privateEvent]);

      const token = await createAccessToken({
        sub: 1,
        email: "admin@test.com",
        role: "admin",
      });

      const { status, body } = await testJson("/api/search?q=retreat", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(status).toBe(200);
      // Admin sees both events (both have "retreat" in title)
      expect(body.results).toHaveLength(2);
    });
  });

  describe("Scoring", () => {
    it("scores sessionThemes matches highest (weight 10)", async () => {
      const event = makeEvent({
        sessionThemesEn: "Bodhicitta practice",
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "General retreat",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=bodhicitta");

      expect(body.results).toHaveLength(1);
      expect(body.results[0].totalScore).toBe(10);
    });

    it("scores mainThemes matches at weight 6", async () => {
      const event = makeEvent({
        sessionThemesEn: null,
        sessionThemesPt: null,
        mainThemesEn: "Compassion and wisdom",
        mainThemesPt: null,
        titleEn: "General retreat",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=compassion");

      expect(body.results).toHaveLength(1);
      expect(body.results[0].totalScore).toBe(6);
    });

    it("scores title matches at weight 3", async () => {
      const event = makeEvent({
        sessionThemesEn: null,
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "Dzogchen Retreat",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=dzogchen");

      expect(body.results).toHaveLength(1);
      expect(body.results[0].totalScore).toBe(3);
    });

    it("scores teacher matches at weight 2", async () => {
      const event = makeEvent({
        sessionThemesEn: null,
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "General retreat",
        titlePt: "Retiro geral",
        eventTeachers: [{ teacher: { name: "Pema Wangyal Rinpoche" } }],
        sessions: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=pema");

      expect(body.results).toHaveLength(1);
      expect(body.results[0].totalScore).toBe(2);
    });

    it("scores track title matches at weight 1 per track", async () => {
      const event = makeEvent({
        sessionThemesEn: null,
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "General retreat",
        titlePt: "Retiro geral",
        eventTeachers: [],
        sessions: [
          {
            id: 10,
            titleEn: "Session 1",
            titlePt: "Sessao 1",
            sessionDate: "2024-04-15",
            timePeriod: "morning",
            sessionNumber: 1,
            tracks: [
              { id: 100, title: "Shamatha meditation guide", trackNumber: 1 },
              { id: 101, title: "Shamatha practice", trackNumber: 2 },
            ],
          },
        ],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=shamatha");

      expect(body.results).toHaveLength(1);
      // 2 tracks matched at weight 1 each
      expect(body.results[0].totalScore).toBe(2);
      expect(body.results[0].sessions[0].matchedTracks).toHaveLength(2);
      expect(body.results[0].sessions[0].matchedFields).toContain("trackTitle");
    });

    it("accumulates scores from multiple matching fields", async () => {
      // Event where sessionThemes + mainThemes + title all match "bodhicitta"
      const event = makeEvent({
        sessionThemesEn: "Bodhicitta introduction",
        sessionThemesPt: null,
        mainThemesEn: "Bodhicitta practice",
        mainThemesPt: null,
        titleEn: "Bodhicitta Retreat",
        titlePt: null,
        eventTeachers: [],
        sessions: [
          {
            id: 10,
            titleEn: "Session 1",
            titlePt: null,
            sessionDate: "2024-04-15",
            timePeriod: "morning",
            sessionNumber: 1,
            tracks: [
              { id: 100, title: "Bodhicitta meditation", trackNumber: 1 },
            ],
          },
        ],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=bodhicitta");

      expect(body.results).toHaveLength(1);
      // sessionThemes (10) + mainThemes (6) + title (3) + 1 track (1) = 20
      expect(body.results[0].totalScore).toBe(20);
    });

    it("sorts results by score descending", async () => {
      const highScoreEvent = makeEvent({
        id: 1,
        sessionThemesEn: "Meditation practice",
        sessionThemesPt: null,
        mainThemesEn: "Deep meditation",
        mainThemesPt: null,
        titleEn: "Meditation Retreat",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      const lowScoreEvent = makeEvent({
        id: 2,
        sessionThemesEn: null,
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "Meditation basics",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([lowScoreEvent, highScoreEvent]);

      const { body } = await testJson("/api/search?q=meditation");

      expect(body.results).toHaveLength(2);
      // High score event (10+6+3=19) should come first
      expect(body.results[0].event.id).toBe(1);
      expect(body.results[0].totalScore).toBeGreaterThan(body.results[1].totalScore);
    });
  });

  describe("Accent-insensitive matching", () => {
    it("matches Portuguese text without accents", async () => {
      const event = makeEvent({
        sessionThemesEn: null,
        sessionThemesPt: null,
        mainThemesPt: "Compaixao e sabedoria",
        mainThemesEn: null,
        titleEn: "Test",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=compaixao");

      expect(body.results).toHaveLength(1);
    });

    it("matches accented query against non-accented text", async () => {
      const event = makeEvent({
        sessionThemesEn: null,
        sessionThemesPt: null,
        mainThemesPt: "Meditacao",
        mainThemesEn: null,
        titleEn: "Test",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      // Query with accent should still match non-accented text
      const { body } = await testJson(
        `/api/search?q=${encodeURIComponent("meditação")}`,
      );

      expect(body.results).toHaveLength(1);
    });
  });

  describe("Response shape", () => {
    it("returns correct response structure", async () => {
      const event = makeEvent();
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=bodhicitta");

      expect(body).toHaveProperty("results");
      expect(body).toHaveProperty("totalResults");
      expect(body).toHaveProperty("query");
      expect(Array.isArray(body.results)).toBe(true);

      const result = body.results[0];
      expect(result).toHaveProperty("event");
      expect(result).toHaveProperty("sessions");
      expect(result).toHaveProperty("totalScore");

      // Event shape
      expect(result.event).toHaveProperty("id");
      expect(result.event).toHaveProperty("titleEn");
      expect(result.event).toHaveProperty("titlePt");
      expect(result.event).toHaveProperty("startDate");
      expect(result.event).toHaveProperty("endDate");
      expect(result.event).toHaveProperty("teachers");
      expect(Array.isArray(result.event.teachers)).toBe(true);

      // Session shape
      const session = result.sessions[0];
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("titleEn");
      expect(session).toHaveProperty("titlePt");
      expect(session).toHaveProperty("sessionDate");
      expect(session).toHaveProperty("timePeriod");
      expect(session).toHaveProperty("sessionNumber");
      expect(session).toHaveProperty("score");
      expect(session).toHaveProperty("matchedFields");
      expect(session).toHaveProperty("matchedTracks");
    });

    it("includes teacher names in event response", async () => {
      const event = makeEvent({
        eventTeachers: [
          { teacher: { name: "Jigme Khyentse Rinpoche" } },
          { teacher: { name: "Pema Wangyal Rinpoche" } },
        ],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=bodhicitta");

      expect(body.results[0].event.teachers).toEqual([
        "Jigme Khyentse Rinpoche",
        "Pema Wangyal Rinpoche",
      ]);
    });

    it("includes matched tracks in session results", async () => {
      const event = makeEvent();
      (db.query.events.findMany as any).mockResolvedValue([event]);

      // "bodhicitta" matches sessionThemes AND track title "Introduction to bodhicitta"
      const { body } = await testJson("/api/search?q=bodhicitta");

      const session = body.results[0].sessions[0];
      expect(session.matchedTracks).toHaveLength(1);
      expect(session.matchedTracks[0].title).toBe("Introduction to bodhicitta");
    });

    it("includes all sessions of matching event even without track matches", async () => {
      const event = makeEvent();
      (db.query.events.findMany as any).mockResolvedValue([event]);

      // "bodhicitta" matches at event level; both sessions should be included
      const { body } = await testJson("/api/search?q=bodhicitta");

      expect(body.results[0].sessions).toHaveLength(2);
    });
  });

  describe("Multi-word queries", () => {
    it("matches when all query words appear in a field", async () => {
      const event = makeEvent({
        sessionThemesEn: "The role of a guru and how to use the guru on the path",
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "General retreat",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=guru%20role");

      expect(body.results).toHaveLength(1);
      // Both words match → full weight 10
      expect(body.results[0].totalScore).toBe(10);
    });

    it("requires ALL words to match (AND logic)", async () => {
      const event = makeEvent({
        sessionThemesEn: "Compassion and bodhicitta practice",
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "General retreat",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      // "compassion emptiness" — "emptiness" not found anywhere → no match
      const { body } = await testJson("/api/search?q=compassion%20emptiness");

      expect(body.results).toHaveLength(0);
    });

    it("returns no results when no query words match", async () => {
      const event = makeEvent({
        sessionThemesEn: "Meditation and mindfulness",
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "General retreat",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=quantum%20physics");

      expect(body.results).toHaveLength(0);
    });

    it("matches across multiple fields with multi-word query", async () => {
      const event = makeEvent({
        sessionThemesEn: "Compassion training",
        sessionThemesPt: null,
        mainThemesEn: "Wisdom teachings",
        mainThemesPt: null,
        titleEn: "Compassion and Wisdom Retreat",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=compassion%20wisdom");

      expect(body.results).toHaveLength(1);
      // sessionThemes: "compassion" matches (1/2 words → 5)
      // mainThemes: "wisdom" matches (1/2 words → 3)
      // title: both match (2/2 words → 3)
      expect(body.results[0].totalScore).toBe(11);
    });

    it("filters out single-character words from query", async () => {
      const event = makeEvent({
        sessionThemesEn: "Compassion and wisdom",
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "General retreat",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      // "a compassion" — "a" is filtered (single char), only "compassion" counts
      const { body } = await testJson("/api/search?q=a%20compassion");

      expect(body.results).toHaveLength(1);
      // 1 word matches at full weight → 10
      expect(body.results[0].totalScore).toBe(10);
    });
  });

  describe("Snippets", () => {
    it("returns snippets array in response", async () => {
      const event = makeEvent();
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=bodhicitta");

      expect(body.results[0]).toHaveProperty("snippets");
      expect(Array.isArray(body.results[0].snippets)).toBe(true);
    });

    it("snippet contains field name and matching text excerpt", async () => {
      const event = makeEvent({
        sessionThemesEn: "The role of a guru and how to use the guru on the path",
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "General retreat",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=guru");

      const snippets = body.results[0].snippets;
      expect(snippets.length).toBeGreaterThan(0);
      expect(snippets[0]).toHaveProperty("field");
      expect(snippets[0]).toHaveProperty("text");
      expect(snippets[0].field).toBe("sessionThemes");
      expect(snippets[0].text.toLowerCase()).toContain("guru");
    });

    it("includes teacher name as snippet when teacher matches", async () => {
      const event = makeEvent({
        sessionThemesEn: null,
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "General retreat",
        titlePt: "Retiro geral",
        eventTeachers: [{ teacher: { name: "Pema Wangyal Rinpoche" } }],
        sessions: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=pema");

      const snippets = body.results[0].snippets;
      expect(snippets).toContainEqual(
        expect.objectContaining({ field: "teacher", text: "Pema Wangyal Rinpoche" }),
      );
    });
  });

  describe("Case insensitivity", () => {
    it("matches regardless of case", async () => {
      const event = makeEvent({
        sessionThemesEn: null,
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "DZOGCHEN Retreat",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=dzogchen");

      expect(body.results).toHaveLength(1);
    });
  });

  describe("Snippet language correctness", () => {
    it("never shows Portuguese snippet when lang=en even if only PT has data", async () => {
      const event = makeEvent({
        sessionThemesEn: null,
        sessionThemesPt: "O papel do guru no caminho espiritual",
        mainThemesEn: null,
        mainThemesPt: "Compreender a funcao de um guru",
        titleEn: "The role of a guru on the path",
        titlePt: "O papel de um guru no caminho",
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=guru&lang=en");

      // Should NOT have snippets from PT fields — only EN fields
      const snippets = body.results[0].snippets;
      for (const snippet of snippets) {
        expect(snippet.text).not.toContain("papel");
        expect(snippet.text).not.toContain("funcao");
        expect(snippet.text).not.toContain("caminho");
        expect(snippet.text).not.toContain("Compreender");
      }
    });

    it("shows English snippet when lang=en and English field matches", async () => {
      const event = makeEvent({
        sessionThemesEn: "Understanding the guru role in practice",
        sessionThemesPt: "Compreender o papel do guru na pratica",
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: "General retreat",
        titlePt: null,
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      const { body } = await testJson("/api/search?q=guru&lang=en");

      const snippets = body.results[0].snippets;
      expect(snippets.length).toBeGreaterThan(0);
      expect(snippets[0].text).toContain("guru");
      // Should be in English, not Portuguese
      expect(snippets[0].text).not.toContain("Compreender");
    });
  });

  describe("Language parameter", () => {
    it("defaults to en language", async () => {
      (db.query.events.findMany as any).mockResolvedValue([]);

      const { body } = await testJson("/api/search?q=test");

      expect(body.query).toBe("test");
    });

    it("accepts pt language parameter", async () => {
      (db.query.events.findMany as any).mockResolvedValue([]);

      const { status } = await testJson("/api/search?q=teste&lang=pt");

      expect(status).toBe(200);
    });

    it("searches both language fields regardless of lang param", async () => {
      const event = makeEvent({
        sessionThemesEn: null,
        sessionThemesPt: null,
        mainThemesEn: null,
        mainThemesPt: null,
        titleEn: null,
        titlePt: "Retiro de Primavera",
        sessions: [],
        eventTeachers: [],
      });
      (db.query.events.findMany as any).mockResolvedValue([event]);

      // Search in English mode but match should still work on Portuguese field
      const { body } = await testJson("/api/search?q=primavera&lang=en");

      expect(body.results).toHaveLength(1);
    });
  });
});
