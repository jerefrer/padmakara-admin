import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const h = vi.hoisted(() => ({
  event: undefined as any,
  counts: { transcripts: 3, videos: 2, texts: 1 },
  history: [] as any[],
}));

vi.mock("../../../src/db/index.ts", () => ({
  db: { query: { events: { findFirst: vi.fn(() => Promise.resolve(h.event)) } } },
}));
vi.mock("../../../src/services/event-recipients.ts", () => ({ listEventRecipients: vi.fn() }));
vi.mock("../../../src/services/event-announcements.ts", () => ({
  countAnnounceableContent: vi.fn(() => Promise.resolve(h.counts)),
  listAnnouncements: vi.fn(() => Promise.resolve(h.history)),
  recordAnnouncement: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../src/services/event-announcement-notify.ts", () => ({
  sendAnnouncementEmails: vi.fn(() => Promise.resolve({ sent: 0, failed: 0 })),
}));

import { createAccessToken } from "../../../src/services/auth.ts";
import { listEventRecipients } from "../../../src/services/event-recipients.ts";
import { recordAnnouncement } from "../../../src/services/event-announcements.ts";
import { sendAnnouncementEmails } from "../../../src/services/event-announcement-notify.ts";

const adminAuth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});
const userAuth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 2, email: "u@test.com", role: "user" })}`,
});

const recipients = [
  { id: 1, email: "a@x.com", firstName: "A", preferredLanguage: "pt" },
  { id: 2, email: "b@x.com", firstName: null, preferredLanguage: "en" },
];

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    status: "published",
    titleEn: "Retreat",
    titlePt: "Retiro",
    publishedNotifiedAt: null,
    publishedNotifiedCount: null,
    transcriptsPublished: true,
    videoPublished: true,
    textsPublished: true,
    ...overrides,
  };
}

const get = async (headers?: Record<string, string>) =>
  testJson("/api/admin/events/5/announcements", { headers: headers ?? (await adminAuth()) });
const post = async (body: unknown, headers?: Record<string, string>) =>
  testJson("/api/admin/events/5/announce", {
    method: "POST",
    headers: headers ?? (await adminAuth()),
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.event = eventRow();
  h.counts = { transcripts: 3, videos: 2, texts: 1 };
  h.history = [];
  vi.mocked(listEventRecipients).mockResolvedValue(recipients);
});

describe("GET /api/admin/events/:id/announcements", () => {
  it("should list the three kinds as available with no history", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({
      recipients: 2,
      published: null,
      kinds: [
        { kind: "transcripts", available: true, announcedAt: null },
        { kind: "videos", available: true, announcedAt: null },
        { kind: "texts", available: true, announcedAt: null },
      ],
      history: [],
    });
  });

  it("should flag a kind hidden when its Show in app flag is off, even with content", async () => {
    h.event = eventRow({ videoPublished: false });
    const { body } = await get();
    expect(body.kinds[1]).toEqual({ kind: "videos", available: false, reason: "hidden", announcedAt: null });
  });

  it("should flag a kind empty when the section has no content", async () => {
    h.counts = { transcripts: 0, videos: 2, texts: 0 };
    const { body } = await get();
    expect(body.kinds[0]).toMatchObject({ kind: "transcripts", available: false, reason: "empty" });
    expect(body.kinds[2]).toMatchObject({ kind: "texts", available: false, reason: "empty" });
  });

  it("should prefer hidden over empty", async () => {
    h.event = eventRow({ textsPublished: false });
    h.counts = { transcripts: 3, videos: 2, texts: 0 };
    const { body } = await get();
    expect(body.kinds[2].reason).toBe("hidden");
  });

  it("should report the latest announcement date per kind and the history newest first", async () => {
    const newer = new Date("2026-11-13T10:00:00.000Z");
    const older = new Date("2026-11-10T10:00:00.000Z");
    h.history = [
      { kinds: ["videos"], sentAt: newer, recipientCount: 4, message: "Hi" },
      { kinds: ["transcripts", "videos"], sentAt: older, recipientCount: 5, message: null },
    ];
    const { body } = await get();
    expect(body.kinds.map((k: any) => k.announcedAt)).toEqual([
      older.toISOString(),
      newer.toISOString(),
      null,
    ]);
    expect(body.history).toEqual([
      { kinds: ["videos"], sentAt: newer.toISOString(), count: 4, message: "Hi" },
      { kinds: ["transcripts", "videos"], sentAt: older.toISOString(), count: 5, message: null },
    ]);
  });

  it("should report the recordings email", async () => {
    const at = new Date("2026-11-01T08:00:00.000Z");
    h.event = eventRow({ publishedNotifiedAt: at, publishedNotifiedCount: 13 });
    const { body } = await get();
    expect(body.published).toEqual({ at: at.toISOString(), count: 13 });
  });

  it("should answer 404 for an unknown event and 403 for a non-admin", async () => {
    h.event = undefined;
    expect((await get()).status).toBe(404);
    h.event = eventRow();
    expect((await get(await userAuth())).status).toBe(403);
  });
});

describe("POST /api/admin/events/:id/announce", () => {
  it("should record the announcement, answer at once and send in the background", async () => {
    const { status, body } = await post({ kinds: ["transcripts", "videos"], message: "  Enjoy  " });

    expect(status).toBe(200);
    expect(body).toEqual({ queued: 2 });
    expect(recordAnnouncement).toHaveBeenCalledWith({
      eventId: 5,
      kinds: ["transcripts", "videos"],
      message: "Enjoy",
      recipientCount: 2,
      sentBy: 1,
    });
    expect(sendAnnouncementEmails).toHaveBeenCalledWith(h.event, recipients, ["transcripts", "videos"], "Enjoy");
  });

  it("should store no message when it is blank", async () => {
    await post({ kinds: ["texts"], message: "   " });
    expect(vi.mocked(recordAnnouncement).mock.calls[0]![0].message).toBeNull();
    expect(sendAnnouncementEmails).toHaveBeenCalledWith(h.event, recipients, ["texts"], undefined);
  });

  it("should answer 400 when no kind is given, a kind is unknown or the message is too long", async () => {
    for (const bad of [{}, { kinds: [] }, { kinds: ["audio"] }, { kinds: ["videos"], message: "a".repeat(1001) }]) {
      const { status, body } = await post(bad);
      expect(status).toBe(400);
      expect(body.code).toBe("VALIDATION_ERROR");
    }
    expect(sendAnnouncementEmails).not.toHaveBeenCalled();
  });

  it("should answer 409 EVENT_NOT_PUBLISHED for an event that is not published", async () => {
    h.event = eventRow({ status: "forthcoming" });
    const { status, body } = await post({ kinds: ["videos"] });
    expect(status).toBe(409);
    expect(body.code).toBe("EVENT_NOT_PUBLISHED");
  });

  it("should answer 400 KIND_NOT_AVAILABLE for a hidden or empty kind", async () => {
    h.event = eventRow({ videoPublished: false });
    expect((await post({ kinds: ["videos"] })).body.code).toBe("KIND_NOT_AVAILABLE");
    h.event = eventRow();
    h.counts = { transcripts: 0, videos: 2, texts: 1 };
    const { status, body } = await post({ kinds: ["transcripts"] });
    expect(status).toBe(400);
    expect(body.code).toBe("KIND_NOT_AVAILABLE");
    expect(recordAnnouncement).not.toHaveBeenCalled();
  });

  it("should answer 409 ALREADY_ANNOUNCED naming the kinds, unless forced", async () => {
    h.history = [{ kinds: ["videos"], sentAt: new Date(), recipientCount: 4, message: null }];
    const refused = await post({ kinds: ["transcripts", "videos"] });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("ALREADY_ANNOUNCED");
    expect(refused.body.details.kinds).toEqual(["videos"]);
    expect(sendAnnouncementEmails).not.toHaveBeenCalled();

    const forced = await post({ kinds: ["transcripts", "videos"], force: true });
    expect(forced.status).toBe(200);
    expect(sendAnnouncementEmails).toHaveBeenCalledTimes(1);
  });

  it("should queue nothing and record nothing when there are no recipients", async () => {
    vi.mocked(listEventRecipients).mockResolvedValue([]);
    const { body } = await post({ kinds: ["videos"] });
    expect(body).toEqual({ queued: 0 });
    expect(recordAnnouncement).not.toHaveBeenCalled();
    expect(sendAnnouncementEmails).not.toHaveBeenCalled();
  });

  it("should answer 404 for an unknown event and 403 for a non-admin", async () => {
    h.event = undefined;
    expect((await post({ kinds: ["videos"] })).status).toBe(404);
    h.event = eventRow();
    expect((await post({ kinds: ["videos"] }, await userAuth())).status).toBe(403);
  });
});
