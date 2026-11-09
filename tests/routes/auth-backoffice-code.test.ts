import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson } from "../helpers.ts";

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      magicLinkTokens: { findMany: vi.fn().mockResolvedValue([]) },
    },
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../../src/services/email.ts", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildMagicLinkEmail: vi.fn(),
  buildAccountDeletionEmail: vi.fn(),
  buildBackofficeCodeEmail: vi.fn().mockReturnValue({ subject: "Code", html: "<p>code</p>", text: "code" }),
}));

import { db } from "../../src/db/index.ts";
import { sendEmail, buildBackofficeCodeEmail } from "../../src/services/email.ts";
import { hashSignInCode, verifySignInCode } from "../../src/services/sign-in-code.ts";

const admin = {
  id: 10, email: "sofia@test.com", firstName: "Sofia", lastName: "C",
  role: "admin", isActive: true, passwordHash: null,
};

function mockInsertChain() {
  return { values: vi.fn().mockReturnThis(), returning: vi.fn().mockResolvedValue([]) };
}

// update() chain whose where() is awaitable AND offers returning()
function mockUpdateWithReturning(returned: unknown[] = [{ id: 11 }]) {
  const set = vi.fn();
  const where = vi.fn(() =>
    Object.assign(Promise.resolve(undefined), { returning: vi.fn().mockResolvedValue(returned) }),
  );
  set.mockReturnValue({ where });
  return { set, where };
}

const requestCode = (email = "Sofia@Test.com") =>
  testJson("/api/auth/backoffice/request-code", {
    method: "POST",
    body: JSON.stringify({ email, language: "en" }),
  });

const verify = (code: string, challengeId = "c".repeat(43)) =>
  testJson("/api/auth/backoffice/verify-code", {
    method: "POST",
    body: JSON.stringify({ email: "Sofia@Test.com", challengeId, code }),
  });

describe("backoffice sign-in by emailed code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.query.users.findFirst as any).mockResolvedValue(admin);
    (db.insert as any).mockReturnValue(mockInsertChain());
  });

  describe("POST /api/auth/backoffice/request-code", () => {
    it("should email a code to an admin and bind it to the returned challenge", async () => {
      const insert = mockInsertChain();
      (db.insert as any).mockReturnValue(insert);

      const { status, body } = await requestCode();

      expect(status).toBe(200);
      const values = insert.values.mock.calls[0]![0];
      const code = (buildBackofficeCodeEmail as any).mock.calls[0][0];
      expect(values.email).toBe("sofia@test.com");
      expect(values.deviceFingerprint).toBe(`backoffice:${body.challengeId}`);
      expect(verifySignInCode(code, values.codeHash)).toBe(true);
      expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "sofia@test.com" }));
      expect(JSON.stringify(body)).not.toContain(code);
    });

    it("should answer the same way without emailing anyone who is not an admin", async () => {
      for (const user of [null, { ...admin, role: "user" }, { ...admin, isActive: false }]) {
        vi.clearAllMocks();
        (db.query.users.findFirst as any).mockResolvedValue(user);

        const { status, body } = await requestCode();

        expect(status).toBe(200);
        expect(Object.keys(body)).toEqual(["challengeId"]);
        expect(sendEmail).not.toHaveBeenCalled();
        expect(db.insert).not.toHaveBeenCalled();
      }
    });

    it("should give a fresh challenge on every request", async () => {
      const a = await requestCode();
      const b = await requestCode();
      expect(a.body.challengeId).not.toBe(b.body.challengeId);
    });
  });

  describe("POST /api/auth/backoffice/verify-code", () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: 11, email: "sofia@test.com", tokenHash: "x",
      expiresAt: new Date(Date.now() + 3600_000), isUsed: false,
      deviceFingerprint: `backoffice:${"c".repeat(43)}`,
      language: "en", codeHash: hashSignInCode("123456"), codeAttempts: 0,
      ...over,
    });

    beforeEach(() => {
      (db.query.magicLinkTokens.findMany as any).mockResolvedValue([row()]);
      (db.update as any).mockReturnValue(mockUpdateWithReturning());
    });

    it("should sign an admin in with the same tokens as the password login", async () => {
      const { status, body } = await verify("123456");

      expect(status).toBe(200);
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
      expect(body.user).toEqual({ id: 10, email: "sofia@test.com", firstName: "Sofia", lastName: "C", role: "admin" });
    });

    it("should reject a code from another browser's challenge", async () => {
      const { status, body } = await verify("123456", "d".repeat(43));
      expect(status).toBe(401);
      expect(body.error).toBe("Invalid or expired code");
    });

    it("should reject a wrong code and count the attempt", async () => {
      const upd = mockUpdateWithReturning();
      (db.update as any).mockReturnValue(upd);

      const { status } = await verify("000000");

      expect(status).toBe(401);
      expect(upd.set).toHaveBeenCalledWith(expect.objectContaining({ codeAttempts: expect.anything() }));
    });

    it("should refuse anyone who is no longer an active admin, with the same error", async () => {
      for (const user of [null, { ...admin, role: "user" }, { ...admin, isActive: false }]) {
        (db.query.users.findFirst as any).mockResolvedValue(user);
        const { status, body } = await verify("123456");
        expect(status).toBe(401);
        expect(body.error).toBe("Invalid or expired code");
      }
    });

    it("should reject a code that is not six digits", async () => {
      expect((await verify("12345")).status).toBe(400);
    });
  });
});
