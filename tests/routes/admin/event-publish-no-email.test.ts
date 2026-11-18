import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../../helpers.ts";

// User decision (André): publishing is quiet; announcing is a separate, explicit step.
const h = vi.hoisted(() => ({ sendEmail: vi.fn(() => Promise.resolve()) }));

vi.mock("../../../src/db/index.ts", () => ({
  db: { query: { events: { findFirst: vi.fn(() => Promise.resolve(undefined)) } } },
}));
vi.mock("../../../src/services/email.ts", () => ({ sendEmail: h.sendEmail }));

import { createAccessToken } from "../../../src/services/auth.ts";

const adminAuth = async () => ({
  Authorization: `Bearer ${await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" })}`,
});

beforeEach(() => vi.clearAllMocks());

describe("publishing an event", () => {
  it("should have no publish-time email endpoint, even when a client sends the old flag", async () => {
    const { status } = await testJson("/api/admin/events/5/notify-published", {
      method: "POST",
      headers: await adminAuth(),
      body: JSON.stringify({ force: true, message: "Hello" }),
    });

    expect(status).toBe(404);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("should no longer expose the publish recipients preview", async () => {
    const { status } = await testJson("/api/admin/events/5/recipients", { headers: await adminAuth() });

    expect(status).toBe(404);
  });
});
