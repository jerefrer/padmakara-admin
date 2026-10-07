import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson, testRequest } from "../helpers.ts";

// Mock the database module before importing anything that uses it
vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
    },
    update: vi.fn(),
  },
}));

import { db } from "../../src/db/index.ts";
import { createAccessToken } from "../../src/services/auth.ts";

function mockUpdateChain() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  return chain;
}

function mockUser(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    email: "user@test.com",
    firstName: "Test",
    lastName: "User",
    role: "user",
    isActive: true,
    subscriptionStatus: "none",
    subscriptionSource: null,
    easypaySubscriptionId: null,
    subscriptionExpiresAt: null,
    ...overrides,
  };
}

async function authHeader(overrides: Record<string, any> = {}) {
  const token = await createAccessToken({
    sub: overrides.sub ?? 1,
    email: overrides.email ?? "user@test.com",
    role: overrides.role ?? "user",
  });
  return { Authorization: `Bearer ${token}` };
}

describe("Payment routes (mock mode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Auth ───

  describe("Authentication", () => {
    it("returns 401 for subscribe without auth", async () => {
      const { status } = await testJson("/api/payment/subscribe", {
        method: "POST",
      });
      expect(status).toBe(401);
    });

    it("returns 401 for cancel without auth", async () => {
      const { status } = await testJson("/api/payment/cancel", {
        method: "POST",
      });
      expect(status).toBe(401);
    });
  });

  // ─── POST /api/payment/subscribe ───

  describe("POST /api/payment/subscribe", () => {
    it("returns 404 when user not found", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(null);

      const headers = await authHeader();
      const { status, body } = await testJson("/api/payment/subscribe", {
        method: "POST",
        headers,
        body: JSON.stringify({ amount: 5, interval: "month" }),
      });

      expect(status).toBe(404);
      expect(body.error).toBe("User not found");
    });

    it("returns 400 when already subscribed", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(
        mockUser({ subscriptionStatus: "active" }),
      );

      const headers = await authHeader();
      const { status, body } = await testJson("/api/payment/subscribe", {
        method: "POST",
        headers,
        body: JSON.stringify({ amount: 5, interval: "month" }),
      });

      expect(status).toBe(400);
      expect(body.error).toBe("You are already a member");
    });

    it("activates subscription in mock mode", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(mockUser());

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const headers = await authHeader();
      const { status, body } = await testJson("/api/payment/subscribe", {
        method: "POST",
        headers,
        body: JSON.stringify({ amount: 5, interval: "month" }),
      });

      expect(status).toBe(200);
      expect(body.url).toContain("/membership/confirming");
      expect(body.url).toContain("checkout=mock_session");
      expect(body.checkout).toEqual({ id: "mock_session", session: "mock" });
      expect(body.testing).toBe(true);

      // Verify DB was updated
      expect(db.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionStatus: "active",
          subscriptionSource: "easypay",
          easypaySubscriptionId: "mock_sub_1",
        }),
      );
    });

    it("sets expiry ~30 days from now", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(mockUser());

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const headers = await authHeader();
      await testJson("/api/payment/subscribe", { method: "POST", headers, body: JSON.stringify({ amount: 5, interval: "month" }) });

      // calls[0] is non-null: the subscribe endpoint must have called db.update().set() at least once
      const setArg = updateChain.set.mock.calls[0]![0];
      const expiresAt = new Date(setArg.subscriptionExpiresAt);
      const now = new Date();
      const diffDays = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThan(27);
      expect(diffDays).toBeLessThan(32);
    });

    it("should allow joining when an admin-granted access has lapsed but still reads active", async () => {
      // Regression: status stays "active" when an admin-set expiry date passes, so the
      // old guard told members who had lost access that they were already subscribed.
      (db.query.users.findFirst as any).mockResolvedValue(
        mockUser({
          subscriptionStatus: "active",
          subscriptionSource: "admin",
          subscriptionExpiresAt: new Date(Date.now() - 60 * 86_400_000),
        }),
      );
      (db.update as any).mockReturnValue(mockUpdateChain());

      const headers = await authHeader();
      const { status } = await testJson("/api/payment/subscribe", { method: "POST", headers, body: JSON.stringify({ amount: 5, interval: "month" }) });

      expect(status).toBe(200);
    });

    it("allows subscription after expiry", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(
        mockUser({ subscriptionStatus: "expired" }),
      );

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const headers = await authHeader();
      const { status, body } = await testJson("/api/payment/subscribe", {
        method: "POST",
        headers,
        body: JSON.stringify({ amount: 5, interval: "month" }),
      });

      expect(status).toBe(200);
      expect(body.url).toContain("/membership/confirming");
    });
  });

  // ─── POST /api/payment/cancel ───

  describe("POST /api/payment/cancel", () => {
    it("returns 404 when user not found", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(null);

      const headers = await authHeader();
      const { status } = await testJson("/api/payment/cancel", {
        method: "POST",
        headers,
      });

      expect(status).toBe(404);
    });

    it("cancels subscription in mock mode", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(
        mockUser({ subscriptionStatus: "active", easypaySubscriptionId: "mock_sub_1" }),
      );

      const updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      const headers = await authHeader();
      const { status, body } = await testJson("/api/payment/cancel", {
        method: "POST",
        headers,
      });

      expect(status).toBe(200);
      expect(body.url).toMatch(/\/membership$/);

      // Cancelling must NOT revoke access: the member paid through
      // subscriptionExpiresAt and keeps it until then.
      const cancelSet = updateChain.set.mock.calls[0]![0];
      expect(cancelSet.subscriptionCancelledAt).toBeInstanceOf(Date);
      expect(cancelSet).not.toHaveProperty("subscriptionStatus");
    });
  });

  describe("mock-mode Easypay isolation", () => {
    it("should not call Easypay when cancelling a mock subscription", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(
        mockUser({ subscriptionStatus: "active", easypaySubscriptionId: "mock_sub_1" }),
      );
      (db.update as any).mockReturnValue(mockUpdateChain());
      const fetchSpy = vi.fn();
      const original = global.fetch;
      global.fetch = fetchSpy as unknown as typeof fetch;
      try {
        const { status } = await testJson("/api/payment/cancel", { method: "POST", headers: await authHeader() });
        expect(status).toBe(200);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        global.fetch = original;
      }
    });

    it("should report checkout-status as pending without calling Easypay when no access exists yet", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(mockUser());
      const fetchSpy = vi.fn();
      const original = global.fetch;
      global.fetch = fetchSpy as unknown as typeof fetch;
      try {
        const { status, body } = await testJson("/api/payment/checkout-status/mock_session", {
          headers: await authHeader(),
        });
        expect(status).toBe(200);
        expect(body).toEqual({ state: "pending", method: null });
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        global.fetch = original;
      }
    });
  });

  // ─── POST /api/payment/webhook ───

  describe("POST /api/payment/webhook", () => {
    it("returns received:true in mock mode", async () => {
      const { status, body } = await testJson("/api/payment/webhook", {
        method: "POST",
        body: JSON.stringify({ id: "test", type: "subscription", status: "active" }),
      });

      expect(status).toBe(200);
      expect(body.received).toBe(true);
      expect(body.mock).toBe(true);
    });
  });

  // ─── GET /api/payment/checkout/:id ───

  describe("GET /api/payment/checkout/:id", () => {
    it("returns HTML with Easypay SDK", async () => {
      const res = await testRequest(
        "/api/payment/checkout/test-id?session=test-session&userId=1",
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("easypayCheckout.startCheckout");
      expect(html).toContain("cdn.easypay.pt/checkout");
      expect(html).toContain("Padmakara");
    });

    it("returns 400 without session parameter", async () => {
      const res = await testRequest("/api/payment/checkout/test-id");
      expect(res.status).toBe(400);
    });

    const get = async (qs: string) =>
      (await testRequest(`/api/payment/checkout/test-id?session=s&${qs}`)).text();

    it("renders Portuguese when lang=pt", async () => {
      const html = await get("amount=10&interval=month&lang=pt");
      expect(html).toContain('<html lang="pt"');
      expect(html).toContain('"pt_PT"');
      expect(html).toContain("Adesão mensal");
    });

    it("defaults to English", async () => {
      const html = await get("amount=10&interval=month");
      expect(html).toContain('<html lang="en"');
      expect(html).toContain('language: "en"');
      expect(html).toContain("Membership, monthly");
    });

    it.each([
      ["en", "month", "10", "Membership, monthly — €10.00 / month"],
      ["en", "year", "120", "Membership, yearly — €120.00 / year"],
      ["pt", "month", "10", "Adesão mensal — 10,00 € / mês"],
      ["pt", "year", "120", "Adesão anual — 120,00 € / ano"],
    ])("should format the order line for %s %s", async (lang, interval, amount, line) => {
      const html = await get(`lang=${lang}&interval=${interval}&amount=${amount}`);
      expect(html).toContain(`<p class="order">${line}</p>`);
    });

    it("shows the update label instead of the order line in update mode", async () => {
      const html = await get("mode=update&amount=10&interval=month");
      expect(html).toContain("Update payment method");
      expect(html).not.toContain("Membership, monthly");
    });

    it("should mark the success redirect as an update when the page is in update mode", async () => {
      const html = await get("mode=update&amount=10&interval=month");
      expect(html).toContain("/membership/confirming?checkout=test-id&mode=update");
    });

    it("should not mark the success redirect as an update when joining", async () => {
      const html = await get("amount=10&interval=month");
      expect(html).not.toContain("mode=update");
    });

    it("redirects to the confirming and closed pages", async () => {
      const html = await get("amount=10&interval=year");
      expect(html).toContain("/membership/confirming?checkout=test-id");
      expect(html).toContain("/membership/closed");
      expect(html).toContain("Membership, yearly");
    });

    it.each([
      ["en", "", "Cancel and return to Padmakara", "/membership/closed"],
      ["pt", "", "Cancelar e voltar à Padmakara", "/membership/closed"],
      ["en", "&mode=update", "Cancel and return to Padmakara", "/membership"],
      ["pt", "&mode=update", "Cancelar e voltar à Padmakara", "/membership"],
    ])("should link out of the page (%s%s)", async (lang, mode, label, path) => {
      const html = await get(`lang=${lang}${mode}&amount=10&interval=month`);
      const m = /<a class="cancel" href="([^"]+)">([^<]+)<\/a>/.exec(html);
      expect(m).not.toBeNull();
      expect(m![2]).toBe(label);
      expect(new URL(m![1]!).pathname).toBe(path);
    });

    it("should hide the declined banner when the checkout fails fatally", async () => {
      const html = await get("amount=10&interval=month");
      const onError = /onError: function\(error\) \{([\s\S]*?)\n      \},\n      onClose/.exec(html);
      expect(onError).not.toBeNull();
      expect(onError![1]).toContain("document.getElementById('declined').style.display = 'none'");
      // ...and a retryable payment error still shows it.
      const onPaymentError = /onPaymentError: function\(error\) \{([\s\S]*?)\n      \},\n      onError/.exec(html);
      expect(onPaymentError![1]).toContain("document.getElementById('declined').style.display = 'block'");
    });

    it("pins the SDK version and is not indexable", async () => {
      const html = await get("amount=10");
      expect(html).toContain("2.9.1");
      expect(html).toContain('<meta name="robots" content="noindex"');
    });

    it("omits the order line and does not inject markup for a malicious amount", async () => {
      const html = await get("amount=%3Cscript%3Ealert(1)%3C%2Fscript%3E&interval=month");
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("Membership, monthly");
    });

    it("omits the order line for a non-positive amount", async () => {
      const html = await get("amount=-5&interval=month");
      expect(html).not.toContain("Membership, monthly");
    });

    it("cannot be broken out of a script by a session value", async () => {
      const html = await (
        await testRequest("/api/payment/checkout/test-id?session=%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E")
      ).text();
      expect(html).not.toContain("</script><script>alert");
    });

    it("falls back to defaults for unknown lang and mode", async () => {
      const html = await get("lang=xx%22&mode=zzz&amount=10&interval=month");
      expect(html).toContain('<html lang="en"');
      expect(html).toContain("Membership, monthly");
    });

    it("keeps banned words out of the page text", async () => {
      for (const lang of ["en", "pt"]) {
        const html = (await get(`lang=${lang}&amount=10&interval=month`))
          .replace(/https:\/\/cdn\.easypay\.pt\/[^"]*/g, "")
          .replace(/hideSubscriptionSummary/g, "");
        expect(html).not.toMatch(/subscription|subscrição|assinatura/i);
      }
    });
  });

  // ─── Full lifecycle ───

  describe("Subscription lifecycle", () => {
    it("subscribe → cancel → re-subscribe", async () => {
      const headers = await authHeader();

      // 1. Subscribe
      (db.query.users.findFirst as any).mockResolvedValue(mockUser());
      let updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      let res = await testJson("/api/payment/subscribe", { method: "POST", headers, body: JSON.stringify({ amount: 5, interval: "month" }) });
      expect(res.status).toBe(200);
      expect(res.body.url).toContain("/membership/confirming");
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionStatus: "active" }),
      );

      // 2. Cancel
      (db.query.users.findFirst as any).mockResolvedValue(
        mockUser({ subscriptionStatus: "active", easypaySubscriptionId: "mock_sub_1" }),
      );
      updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      res = await testJson("/api/payment/cancel", { method: "POST", headers });
      expect(res.status).toBe(200);
      expect(res.body.url).toMatch(/\/membership$/);
      expect(updateChain.set.mock.calls[0]![0].subscriptionCancelledAt).toBeInstanceOf(Date);

      // 3. Re-subscribe
      (db.query.users.findFirst as any).mockResolvedValue(
        mockUser({ subscriptionStatus: "expired" }),
      );
      updateChain = mockUpdateChain();
      (db.update as any).mockReturnValue(updateChain);

      res = await testJson("/api/payment/subscribe", { method: "POST", headers, body: JSON.stringify({ amount: 5, interval: "month" }) });
      expect(res.status).toBe(200);
      expect(res.body.url).toContain("/membership/confirming");
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionStatus: "active" }),
      );
    });
  });
});
