import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

const h = vi.hoisted(() => ({
  event: undefined as any,
  claimRows: [{ id: 5 }] as any[],
  updateSet: undefined as any,
}));

vi.mock("../../../src/db/index.ts", () => ({
  db: {
    query: { events: { findFirst: vi.fn(() => Promise.resolve(h.event)) } },
    update: vi.fn(() => ({
      set: (v: any) => {
        h.updateSet = v;
        return { where: () => ({ returning: () => Promise.resolve(h.claimRows) }) };
      },
    })),
  },
}));
vi.mock("../../../src/services/event-recipients.ts", () => ({ listEventRecipients: vi.fn() }));
vi.mock("../../../src/services/event-publish-notify.ts", () => ({
  sendPublishedEmails: vi.fn(() => Promise.resolve({ sent: 0, failed: 0 })),
}));

import { createAccessToken } from "../../../src/services/auth.ts";
import { listEventRecipients } from "../../../src/services/event-recipients.ts";
import { sendPublishedEmails } from "../../../src/services/event-publish-notify.ts";

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
    audience: { slug: "retreat-group-members" },
    ...overrides,
  };
}

const post = async (body: unknown = {}, headers?: Record<string, string>) =>
  testJson("/api/admin/events/5/notify-published", {
    method: "POST",
    headers: headers ?? (await adminAuth()),
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.event = eventRow();
  h.claimRows = [{ id: 5 }];
  h.updateSet = undefined;
  vi.mocked(listEventRecipients).mockResolvedValue(recipients);
});

describe("GET /api/admin/events/:id/recipients", () => {
  it("should return the count and the notification state", async () => {
    const at = "2026-11-13T10:00:00.000Z";
    h.event = eventRow({ publishedNotifiedAt: new Date(at), publishedNotifiedCount: 7 });

    const { status, body } = await testJson("/api/admin/events/5/recipients", { headers: await adminAuth() });

    expect(status).toBe(200);
    expect(body).toEqual({ count: 2, notifiedAt: at, notifiedCount: 7, notifyByDefault: true });
  });

  it("should return nulls when nobody was emailed yet", async () => {
    const { body } = await testJson("/api/admin/events/5/recipients", { headers: await adminAuth() });
    expect(body).toEqual({ count: 2, notifiedAt: null, notifiedCount: null, notifyByDefault: true });
  });

  it("should not suggest emailing when the event is open to everyone or to any account", async () => {
    for (const slug of ["free-anyone", "account-holders"]) {
      h.event = eventRow({ audience: { slug } });
      const { body } = await testJson("/api/admin/events/5/recipients", { headers: await adminAuth() });
      expect(body).toMatchObject({ notifyByDefault: false });
    }
  });

  it("should answer 404 for an unknown event", async () => {
    h.event = undefined;
    const { status } = await testJson("/api/admin/events/5/recipients", { headers: await adminAuth() });
    expect(status).toBe(404);
  });

  it("should refuse a non-admin", async () => {
    const { status } = await testJson("/api/admin/events/5/recipients", { headers: await userAuth() });
    expect(status).toBe(403);
  });
});

describe("POST /api/admin/events/:id/notify-published", () => {
  it("should queue the emails, record the send and answer at once", async () => {
    const { status, body } = await post();

    expect(status).toBe(200);
    expect(body).toEqual({ queued: 2 });
    expect(h.updateSet.publishedNotifiedCount).toBe(2);
    expect(h.updateSet.publishedNotifiedAt).toBeInstanceOf(Date);
    expect(sendPublishedEmails).toHaveBeenCalledWith(h.event, recipients, undefined, undefined);
  });

  it("should pass the trimmed personal message to the sender", async () => {
    const { status } = await post({ message: "  Welcome back.\nWith love  " });
    expect(status).toBe(200);
    expect(sendPublishedEmails).toHaveBeenCalledWith(h.event, recipients, undefined, "Welcome back.\nWith love");
  });

  it("should treat a blank message as none", async () => {
    await post({ message: "   " });
    expect(sendPublishedEmails).toHaveBeenCalledWith(h.event, recipients, undefined, undefined);
  });

  it("should accept a message of exactly 1000 characters", async () => {
    const { status } = await post({ message: "a".repeat(1000) });
    expect(status).toBe(200);
  });

  it("should answer 400 when the message is over 1000 characters", async () => {
    const { status, body } = await post({ message: "a".repeat(1001) });
    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(sendPublishedEmails).not.toHaveBeenCalled();
    expect(h.updateSet).toBeUndefined();
  });

  it("should answer 400 when the message is not text", async () => {
    const { status } = await post({ message: 42 });
    expect(status).toBe(400);
  });

  it("should answer 409 EVENT_NOT_PUBLISHED for a forthcoming event", async () => {
    h.event = eventRow({ status: "forthcoming" });
    const { status, body } = await post();
    expect(status).toBe(409);
    expect(body.code).toBe("EVENT_NOT_PUBLISHED");
    expect(sendPublishedEmails).not.toHaveBeenCalled();
  });

  it("should answer 409 ALREADY_NOTIFIED when already sent", async () => {
    h.event = eventRow({ publishedNotifiedAt: new Date() });
    const { status, body } = await post();
    expect(status).toBe(409);
    expect(body.code).toBe("ALREADY_NOTIFIED");
    expect(sendPublishedEmails).not.toHaveBeenCalled();
  });

  it("should send again when forced", async () => {
    h.event = eventRow({ publishedNotifiedAt: new Date() });
    const { status, body } = await post({ force: true });
    expect(status).toBe(200);
    expect(body).toEqual({ queued: 2 });
    expect(sendPublishedEmails).toHaveBeenCalledTimes(1);
  });

  it("should answer 409 when another request claimed the send first", async () => {
    h.claimRows = [];
    const { status, body } = await post();
    expect(status).toBe(409);
    expect(body.code).toBe("ALREADY_NOTIFIED");
    expect(sendPublishedEmails).not.toHaveBeenCalled();
  });

  it("should queue nothing and record nothing when there are no recipients", async () => {
    vi.mocked(listEventRecipients).mockResolvedValue([]);
    const { body } = await post();
    expect(body).toEqual({ queued: 0 });
    expect(h.updateSet).toBeUndefined();
    expect(sendPublishedEmails).not.toHaveBeenCalled();
  });

  it("should answer 404 for an unknown event", async () => {
    h.event = undefined;
    const { status } = await post();
    expect(status).toBe(404);
  });

  it("should refuse a non-admin", async () => {
    const { status } = await post({}, await userAuth());
    expect(status).toBe(403);
    expect(sendPublishedEmails).not.toHaveBeenCalled();
  });
});
