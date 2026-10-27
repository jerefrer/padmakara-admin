import { describe, it, expect, vi, beforeEach } from "vitest";

// Easypay is "configured" for this file so the recurring-cancel path is reachable.
vi.hoisted(() => {
  process.env.EASYPAY_ACCOUNT_ID = "test-account";
});

const { txDelete, txUpdate, tx, deactivate } = vi.hoisted(() => {
  const txDelete = vi.fn();
  const txUpdate = vi.fn();
  return {
    txDelete,
    txUpdate,
    tx: { delete: txDelete, update: txUpdate },
    deactivate: vi.fn(),
  };
});

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      accountDeletionTokens: { findFirst: vi.fn() },
    },
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("../../src/services/email.ts", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildMagicLinkEmail: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
  buildAccountDeletionEmail: vi.fn().mockReturnValue({ subject: "s", html: "h", text: "t" }),
}));

// Keep the real payment routes (the app mounts them); replace only the Easypay call.
vi.mock("../../src/routes/payment.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/routes/payment.ts")>()),
  deactivateAtEasypay: deactivate,
}));

import { db } from "../../src/db/index.ts";
import { paymentTransactions } from "../../src/db/schema/payment-transactions.ts";
import { users } from "../../src/db/schema/users.ts";
import { createAccessToken, hashToken } from "../../src/services/auth.ts";
import { sendEmail, buildAccountDeletionEmail } from "../../src/services/email.ts";
import { testJson } from "../helpers.ts";

const member = (over: Record<string, unknown> = {}) => ({
  id: 7,
  email: "member@test.com",
  role: "user",
  preferredLanguage: "pt",
  easypaySubscriptionId: null,
  subscriptionCancelledAt: null,
  ...over,
});

async function bearer(id = 7, role = "user") {
  const token = await createAccessToken({ sub: id, email: "member@test.com", role });
  return { Authorization: `Bearer ${token}` };
}

function deleteAccount(headers: Record<string, string> = {}) {
  return testJson("/api/auth/user/delete", { method: "DELETE", headers });
}

function deletedTables() {
  return txDelete.mock.calls.map((c) => c[0]);
}

describe("account deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txDelete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const setWhere = vi.fn().mockResolvedValue(undefined);
    txUpdate.mockReturnValue({ set: vi.fn().mockReturnValue({ where: setWhere }) });
    (db.transaction as any).mockImplementation(async (cb: any) => cb(tx));
    deactivate.mockResolvedValue("stopped");
  });

  describe("DELETE /api/auth/user/delete", () => {
    it("should return 401 when the request is unauthenticated", async () => {
      const { status } = await deleteAccount();
      expect(status).toBe(401);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("should delete the user and their data in one transaction", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(member());

      const { status, body } = await deleteAccount(await bearer());

      expect(status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(deletedTables()).toContain(users);
      // the user row goes last, after every child
      expect(deletedTables().at(-1)).toBe(users);
    });

    it("should detach payment records instead of deleting them", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(member());

      await deleteAccount(await bearer());

      expect(deletedTables()).not.toContain(paymentTransactions);
      const updatedTables = txUpdate.mock.calls.map((c) => c[0]);
      expect(updatedTables).toContain(paymentTransactions);
      const set = txUpdate.mock.results[updatedTables.indexOf(paymentTransactions)]!.value.set;
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
    });

    it("should cancel the recurring Easypay payment before deleting", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(member({ easypaySubscriptionId: "sub-abc" }));

      const { status } = await deleteAccount(await bearer());

      expect(status).toBe(200);
      expect(deactivate).toHaveBeenCalledWith("sub-abc");
      expect(deactivate.mock.invocationCallOrder[0]!).toBeLessThan(
        (db.transaction as any).mock.invocationCallOrder[0],
      );
    });

    it("should not call Easypay when the member already cancelled", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(
        member({ easypaySubscriptionId: "sub-abc", subscriptionCancelledAt: new Date() }),
      );

      await deleteAccount(await bearer());

      expect(deactivate).not.toHaveBeenCalled();
    });

    it("should keep the account and answer 502 when Easypay cannot cancel", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(member({ easypaySubscriptionId: "sub-abc" }));
      deactivate.mockResolvedValue("failed");

      const { status, body } = await deleteAccount(await bearer());

      expect(status).toBe(502);
      expect(body.code).toBe("PAYMENT_CANCEL_FAILED");
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it.each(["admin", "superadmin"])("should refuse with 409 when the user is %s", async (role) => {
      (db.query.users.findFirst as any).mockResolvedValue(member({ role }));

      const { status, body } = await deleteAccount(await bearer(7, role));

      expect(status).toBe(409);
      expect(body.code).toBe("ADMIN_ACCOUNT");
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/auth/account-deletion/request", () => {
    const request = (email: string, extra: Record<string, unknown> = {}) =>
      testJson("/api/auth/account-deletion/request", {
        method: "POST",
        body: JSON.stringify({ email, ...extra }),
      });

    beforeEach(() => {
      (db.delete as any).mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      (db.insert as any).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    });

    it("should email a confirmation link when the account exists", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(member());

      const { status, body } = await request("Member@Test.com");

      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "member@test.com" }));
      expect(buildAccountDeletionEmail).toHaveBeenCalledWith(
        expect.stringMatching(/\/account-deletion\?token=[0-9a-f]{64}$/),
        "pt",
      );
    });

    it("should answer identically and send nothing when the account does not exist", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(member());
      const known = await request("member@test.com");
      vi.clearAllMocks();
      (db.query.users.findFirst as any).mockResolvedValue(null);

      const unknown = await request("nobody@test.com");

      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("should send nothing for an admin account but answer the same", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(member({ role: "admin" }));

      const { status } = await request("member@test.com");

      expect(status).toBe(200);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it("should still answer 200 when the mailer fails", async () => {
      (db.query.users.findFirst as any).mockResolvedValue(member());
      (sendEmail as any).mockRejectedValueOnce(new Error("ses down"));

      const { status } = await request("member@test.com");

      expect(status).toBe(200);
    });

    it("should return 400 when the email is malformed", async () => {
      const { status } = await request("not-an-email");
      expect(status).toBe(400);
    });
  });

  describe("POST /api/auth/account-deletion/confirm", () => {
    const confirm = (token: unknown) =>
      testJson("/api/auth/account-deletion/confirm", {
        method: "POST",
        body: JSON.stringify({ token }),
      });

    it("should run the deletion when the token is valid", async () => {
      (db.query.accountDeletionTokens.findFirst as any).mockResolvedValue({
        email: "member@test.com",
        tokenHash: await hashToken("good"),
      });
      (db.query.users.findFirst as any).mockResolvedValue(member({ easypaySubscriptionId: "sub-abc" }));

      const { status, body } = await confirm("good");

      expect(status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(deactivate).toHaveBeenCalledWith("sub-abc");
      expect(deletedTables()).toContain(users);
    });

    it("should return 400 when the token is unknown or expired", async () => {
      (db.query.accountDeletionTokens.findFirst as any).mockResolvedValue(undefined);

      const { status, body } = await confirm("bad");

      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_TOKEN");
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("should return 400 when the account no longer exists", async () => {
      (db.query.accountDeletionTokens.findFirst as any).mockResolvedValue({ email: "gone@test.com" });
      (db.query.users.findFirst as any).mockResolvedValue(undefined);

      const { status } = await confirm("good");

      expect(status).toBe(400);
    });

    it("should refuse with 409 when the token belongs to an admin", async () => {
      (db.query.accountDeletionTokens.findFirst as any).mockResolvedValue({ email: "member@test.com" });
      (db.query.users.findFirst as any).mockResolvedValue(member({ role: "admin" }));

      const { status } = await confirm("good");

      expect(status).toBe(409);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("should return 400 when the token is missing", async () => {
      const { status } = await confirm(undefined);
      expect(status).toBe(400);
    });
  });
});
