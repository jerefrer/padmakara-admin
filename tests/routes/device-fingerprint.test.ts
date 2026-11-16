import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { testJson, testRequest } from "../helpers.ts";

// The device fingerprint obtains session tokens, so it is treated as a
// credential: stored hashed, never returned, handed out by /device/discover
// only once after a confirmed link, and good for a silent sign-back-in only in
// the current format on a device used within 12 months.

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      refreshTokens: { findFirst: vi.fn() },
      magicLinkTokens: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      deviceActivations: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      userGroupMemberships: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    },
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../../src/services/email.ts", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  buildMagicLinkEmail: vi.fn().mockReturnValue({ subject: "Link", html: "<p>link</p>" }),
  buildAccountDeletionEmail: vi.fn(),
  buildBackofficeCodeEmail: vi.fn().mockReturnValue({ subject: "Code", html: "<p>code</p>", text: "code" }),
}));

import { db } from "../../src/db/index.ts";
import { sendEmail, buildBackofficeCodeEmail } from "../../src/services/email.ts";
import { createAccessToken } from "../../src/services/auth.ts";
import { hashSignInCode } from "../../src/services/sign-in-code.ts";
import { hashDeviceFingerprint } from "../../src/lib/device-fingerprint.ts";

const dialect = new PgDialect();
/** The SQL text and bound values of a drizzle `where` condition. */
function render(where: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(where as SQL);
}

// 32 random bytes, base64url without padding: what app builds after 46 send.
const NEW_FP = "q3Jd8-ZpX_2mVwT0bL9sYc4nR7uKeA1hGfDiOjM5tWx";
const OTHER_NEW_FP = "Z9y8X7w6V5u4T3s2R1q0P-o_N9m8L7k6J5i4H3g2F1e";
// Build 46: base64 of a JSON object of device info.
const LEGACY_FP = Buffer.from(
  JSON.stringify({
    platform: "ios", brand: "Apple", modelName: "iPhone 15", osVersion: "18.1",
    timestamp: 1731000000000, random: "k2j3h4g5f6",
  }),
).toString("base64");

const user = {
  id: 5, email: "ana@test.com", firstName: "Ana", lastName: "Silva",
  dharmaName: null, preferredLanguage: "en", role: "user",
  isActive: true, isVerified: true,
  subscriptionStatus: "none", subscriptionSource: null, subscriptionExpiresAt: null,
  subscriptionCancelledAt: null, subscriptionAmount: null,
  lastActivity: null, createdAt: new Date(),
};

const MONTH_MS = 30 * 24 * 3600 * 1000;

function activation(over: Record<string, unknown> = {}) {
  return {
    id: 21, userId: 5, deviceFingerprint: hashDeviceFingerprint(NEW_FP),
    deviceName: "Ana's iPhone", deviceType: "ios", isActive: true,
    ipAddress: null, userAgent: null, pendingClaim: false,
    activatedAt: new Date(Date.now() - MONTH_MS), lastUsed: new Date(),
    ...over,
  };
}

function insertChain() {
  return { values: vi.fn().mockReturnThis(), returning: vi.fn().mockResolvedValue([]) };
}

// update() chain whose where() is awaitable AND offers returning()
function updateChain(returned: unknown[] = [{ id: 1 }]) {
  const set = vi.fn();
  const returning = vi.fn().mockResolvedValue(returned);
  const where = vi.fn(() => Object.assign(Promise.resolve(undefined), { returning }));
  set.mockReturnValue({ where });
  return { set, where, returning };
}

/**
 * A findFirst that behaves like the real one for the conditions these routes
 * use: the row matches when its stored fingerprint is a bound value and, if
 * the query filters on them, its user id and active flag match too.
 */
function findFirstOver(rows: ReturnType<typeof activation>[]) {
  return (async ({ where }: { where: unknown }) => {
    const { sql, params } = render(where);
    return rows.find(
      (r) =>
        params.includes(r.deviceFingerprint) &&
        (!sql.includes('"user_id"') || params.includes(r.userId)) &&
        (!sql.includes('"is_active"') || r.isActive),
    );
  });
}

async function bearer(id = 5) {
  const token = await createAccessToken({ sub: id, email: "ana@test.com", role: "user" });
  return { Authorization: `Bearer ${token}` };
}

const deviceBody = (fingerprint: string) => ({
  device_fingerprint: fingerprint, device_name: "Ana's iPhone", device_type: "ios",
});

const requestLink = (fingerprint: string) =>
  testJson("/api/auth/request-magic-link", {
    method: "POST",
    body: JSON.stringify({ email: "ana@test.com", ...deviceBody(fingerprint) }),
  });

const discover = (fingerprint: string) =>
  testJson("/api/auth/device/discover", {
    method: "POST",
    body: JSON.stringify({ device_fingerprint: fingerprint }),
  });

const confirmLink = () =>
  testRequest("/api/auth/activate/sometoken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "http://localhost" },
    body: "",
  });

function linkRow(over: Record<string, unknown> = {}) {
  return {
    id: 31, email: "ana@test.com", tokenHash: "x",
    expiresAt: new Date(Date.now() + 3600_000), isUsed: false,
    deviceFingerprint: hashDeviceFingerprint(NEW_FP),
    deviceName: "Ana's iPhone", deviceType: "ios", language: "en",
    codeHash: hashSignInCode("246810"), codeAttempts: 0,
    ...over,
  };
}

describe("device fingerprint as a credential", () => {
  let upd: ReturnType<typeof updateChain>;
  let ins: ReturnType<typeof insertChain>;

  beforeEach(() => {
    vi.clearAllMocks();
    (db.query.users.findFirst as any).mockResolvedValue(user);
    (db.query.deviceActivations.findFirst as any).mockResolvedValue(undefined);
    (db.query.magicLinkTokens.findMany as any).mockResolvedValue([]);
    upd = updateChain();
    (db.update as any).mockReturnValue(upd);
    ins = insertChain();
    (db.insert as any).mockReturnValue(ins);
  });

  describe("stored hashed", () => {
    it("should store the SHA-256 of the fingerprint with a requested link, never the fingerprint", async () => {
      await requestLink(NEW_FP);

      const values = ins.values.mock.calls[0]![0];
      expect(values.deviceFingerprint).toBe(hashDeviceFingerprint(NEW_FP));
      expect(JSON.stringify(ins.values.mock.calls)).not.toContain(NEW_FP);
    });

    it("should look an activation up by the hash when a link is requested", async () => {
      await requestLink(NEW_FP);

      const { params } = render((db.query.deviceActivations.findFirst as any).mock.calls[0][0].where);
      expect(params).toContain(hashDeviceFingerprint(NEW_FP));
      expect(params).not.toContain(NEW_FP);
    });

    it("should store the hash when a device is activated in the app", async () => {
      (db.query.magicLinkTokens.findFirst as any).mockResolvedValue(linkRow());

      const { status } = await testJson("/api/auth/auto-activate", {
        method: "POST",
        body: JSON.stringify({ token: "sometoken", ...deviceBody(NEW_FP) }),
      });

      expect(status).toBe(200);
      const activationInsert = ins.values.mock.calls.find(([v]) => "deviceName" in v)![0];
      expect(activationInsert.deviceFingerprint).toBe(hashDeviceFingerprint(NEW_FP));
    });

    it("should sign in with the code when the link row holds the hash", async () => {
      (db.query.magicLinkTokens.findMany as any).mockResolvedValue([linkRow()]);

      const { status, body } = await testJson("/api/auth/verify-code", {
        method: "POST",
        body: JSON.stringify({ email: "ana@test.com", code: "246810", ...deviceBody(NEW_FP) }),
      });

      expect(status).toBe(200);
      expect(body.access_token).toBeDefined();
      const { params } = render((db.query.magicLinkTokens.findMany as any).mock.calls[0][0].where);
      expect(params).toContain(hashDeviceFingerprint(NEW_FP));
    });

    it("should copy the stored hash to the activation when a link is confirmed, not hash it again", async () => {
      (db.query.magicLinkTokens.findFirst as any).mockResolvedValue(linkRow());

      await confirmLink();

      const activationInsert = ins.values.mock.calls.find(([v]) => "deviceName" in v)![0];
      expect(activationInsert.deviceFingerprint).toBe(hashDeviceFingerprint(NEW_FP));
    });

    it("should still hand an existing activation to whoever confirmed the link (shared device)", async () => {
      // The device was activated for user 9; Ana (5) confirms a link from it.
      const previous = activation({ userId: 9, isActive: false });
      (db.query.deviceActivations.findFirst as any).mockImplementation(findFirstOver([previous]));
      (db.query.magicLinkTokens.findFirst as any).mockResolvedValue(linkRow());

      await confirmLink();

      const reassigned = upd.set.mock.calls.map(([v]) => v).find((v) => "userId" in v);
      expect(reassigned).toMatchObject({ userId: 5, isActive: true });
      expect(ins.values.mock.calls.some(([v]) => "deviceName" in v)).toBe(false);
    });

    it("should bind the backoffice code to the hash of its challenge", async () => {
      (db.query.users.findFirst as any).mockResolvedValue({ ...user, role: "admin" });

      const { body } = await testJson("/api/auth/backoffice/request-code", {
        method: "POST",
        body: JSON.stringify({ email: "ana@test.com", language: "en" }),
      });

      const values = ins.values.mock.calls[0]![0];
      expect(values.deviceFingerprint).toBe(hashDeviceFingerprint(`backoffice:${body.challengeId}`));
      expect(buildBackofficeCodeEmail).toHaveBeenCalled();
    });

    it("should sign an admin in to the backoffice with the code bound to a hashed challenge", async () => {
      const challengeId = "c".repeat(43);
      (db.query.users.findFirst as any).mockResolvedValue({ ...user, role: "admin" });
      (db.query.magicLinkTokens.findMany as any).mockResolvedValue([
        linkRow({ deviceFingerprint: hashDeviceFingerprint(`backoffice:${challengeId}`) }),
      ]);

      const { status, body } = await testJson("/api/auth/backoffice/verify-code", {
        method: "POST",
        body: JSON.stringify({ email: "ana@test.com", challengeId, code: "246810" }),
      });

      expect(status).toBe(200);
      expect(body.accessToken).toBeDefined();
    });
  });

  describe("POST /api/auth/device/discover is a one-time claim", () => {
    it("should mark the activation as waiting to be claimed when a link is confirmed", async () => {
      (db.query.magicLinkTokens.findFirst as any).mockResolvedValue(linkRow());

      await confirmLink();

      const activationInsert = ins.values.mock.calls.find(([v]) => "deviceName" in v)![0];
      expect(activationInsert.pendingClaim).toBe(true);
    });

    it("should mark a reactivated device as waiting to be claimed too", async () => {
      (db.query.deviceActivations.findFirst as any).mockImplementation(findFirstOver([activation({ isActive: false })]));
      (db.query.magicLinkTokens.findFirst as any).mockResolvedValue(linkRow());

      await confirmLink();

      const reassigned = upd.set.mock.calls.map(([v]) => v).find((v) => "userId" in v);
      expect(reassigned.pendingClaim).toBe(true);
    });

    it("should give tokens once and answer not_activated on the next poll", async () => {
      const claim = updateChain([activation({ pendingClaim: true })]);
      const none = updateChain([]);
      const other = updateChain();
      (db.update as any)
        .mockReturnValueOnce(claim)
        .mockReturnValueOnce(other)
        .mockReturnValueOnce(none)
        .mockReturnValue(other);

      const first = await discover(NEW_FP);
      const second = await discover(NEW_FP);

      expect(first.body.status).toBe("activated");
      expect(first.body.access_token).toBeDefined();
      expect(second.body).toEqual({ status: "not_activated", message: "Device not activated yet" });
      // The claim is taken and cleared in one statement, for the hashed fingerprint only.
      const { sql, params } = render(claim.where.mock.calls[0]![0]);
      expect(sql).toContain('"pending_claim"');
      expect(params).toContain(hashDeviceFingerprint(NEW_FP));
      expect(params).not.toContain(NEW_FP);
      expect(claim.set).toHaveBeenCalledWith(expect.objectContaining({ pendingClaim: false }));
    });

    it("should not return the fingerprint in the device block", async () => {
      (db.update as any).mockReturnValueOnce(updateChain([activation({ pendingClaim: true })]));

      const { body } = await discover(NEW_FP);

      expect(body.status).toBe("activated");
      expect(body.device).not.toHaveProperty("device_fingerprint");
      expect(Object.keys(body.device).sort()).toEqual(
        ["activated_at", "device_name", "is_active", "user_name"],
      );
    });
  });

  describe("signing back in without email", () => {
    it("should give tokens to a current-format fingerprint used within 12 months", async () => {
      (db.query.deviceActivations.findFirst as any).mockImplementation(findFirstOver([activation()]));

      const { body } = await requestLink(NEW_FP);

      expect(body.status).toBe("already_activated");
      expect(body.access_token).toBeDefined();
    });

    it("should send an email instead of tokens to a legacy fingerprint, even when active", async () => {
      (db.query.deviceActivations.findFirst as any).mockResolvedValue(
        activation({ deviceFingerprint: hashDeviceFingerprint(LEGACY_FP) }),
      );

      const { status, body } = await requestLink(LEGACY_FP);

      expect(status).toBe(200);
      expect(body.status).toBe("magic_link_sent");
      expect(body.access_token).toBeUndefined();
      expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "ana@test.com" }));
    });

    it("should send an email instead of tokens to a device unused for 13 months", async () => {
      (db.query.deviceActivations.findFirst as any).mockResolvedValue(
        activation({ lastUsed: new Date(Date.now() - 13 * MONTH_MS) }),
      );

      const { body } = await requestLink(NEW_FP);

      expect(body.status).toBe("magic_link_sent");
      expect(body.access_token).toBeUndefined();
      expect(sendEmail).toHaveBeenCalled();
    });

    it("should accept the legacy fingerprint build 46 sends", async () => {
      const { status } = await requestLink(LEGACY_FP);
      expect(status).toBe(200);
    });

    it("should reject a fingerprint longer than 1024 characters", async () => {
      const { status } = await requestLink("a".repeat(1025));
      expect(status).toBe(400);
    });
  });

  describe("GET /api/auth/devices", () => {
    it("should list devices without their fingerprint", async () => {
      (db.query.deviceActivations.findMany as any).mockResolvedValue([activation()]);

      const { status, body } = await testJson("/api/auth/devices", { headers: await bearer() });

      expect(status).toBe(200);
      expect(body[0]).not.toHaveProperty("device_fingerprint");
      expect(Object.keys(body[0]).sort()).toEqual(
        ["activated_at", "device_name", "device_type", "id", "is_active", "last_used"],
      );
    });
  });

  describe("POST /api/auth/device/deactivate", () => {
    it("should find the device by the hash of the fingerprint", async () => {
      (db.query.deviceActivations.findFirst as any).mockImplementation(findFirstOver([activation()]));

      const { body } = await testJson("/api/auth/device/deactivate", {
        method: "POST",
        headers: await bearer(),
        body: JSON.stringify({ device_fingerprint: NEW_FP }),
      });

      expect(body.status).toBe("deactivated");
    });
  });

  describe("POST /api/auth/device/rotate", () => {
    const rotate = async (body: Record<string, unknown>, id = 5) =>
      testJson("/api/auth/device/rotate", {
        method: "POST",
        headers: await bearer(id),
        body: JSON.stringify(body),
      });

    it("should move the caller's activation from the old fingerprint to the new one", async () => {
      (db.query.deviceActivations.findFirst as any).mockImplementation(findFirstOver([
        activation({ deviceFingerprint: hashDeviceFingerprint(LEGACY_FP) }),
      ]));

      const { status, body } = await rotate({ old_fingerprint: LEGACY_FP, new_fingerprint: NEW_FP });

      expect(status).toBe(200);
      expect(body).toEqual({ status: "rotated" });
      expect(upd.set).toHaveBeenCalledWith(
        expect.objectContaining({ deviceFingerprint: hashDeviceFingerprint(NEW_FP) }),
      );
      const { params } = render(upd.where.mock.calls[0]![0]);
      expect(params).toContain(21);
    });

    it("should answer 404 for another user's fingerprint", async () => {
      (db.query.deviceActivations.findFirst as any).mockImplementation(findFirstOver([
        activation({ userId: 9, deviceFingerprint: hashDeviceFingerprint(LEGACY_FP) }),
      ]));

      const { status } = await rotate({ old_fingerprint: LEGACY_FP, new_fingerprint: NEW_FP });

      expect(status).toBe(404);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("should answer 404 for an inactive activation", async () => {
      (db.query.deviceActivations.findFirst as any).mockImplementation(findFirstOver([
        activation({ isActive: false, deviceFingerprint: hashDeviceFingerprint(LEGACY_FP) }),
      ]));

      const { status } = await rotate({ old_fingerprint: LEGACY_FP, new_fingerprint: NEW_FP });

      expect(status).toBe(404);
    });

    it("should answer 400 for a new fingerprint not in the current format", async () => {
      for (const bad of [LEGACY_FP, NEW_FP.slice(1), `${NEW_FP.slice(1)}=`, `${NEW_FP.slice(1)}+`]) {
        const { status } = await rotate({ old_fingerprint: LEGACY_FP, new_fingerprint: bad });
        expect(status).toBe(400);
      }
      expect(db.update).not.toHaveBeenCalled();
    });

    it("should answer 409 without saying whose when the new fingerprint is taken", async () => {
      (db.query.deviceActivations.findFirst as any).mockImplementation(findFirstOver([
        activation({ deviceFingerprint: hashDeviceFingerprint(LEGACY_FP) }),
        activation({ id: 22, userId: 9, deviceFingerprint: hashDeviceFingerprint(OTHER_NEW_FP) }),
      ]));

      const { status, body } = await rotate({ old_fingerprint: LEGACY_FP, new_fingerprint: OTHER_NEW_FP });

      expect(status).toBe(409);
      expect(JSON.stringify(body)).not.toMatch(/ana|user/i);
      expect(db.update).not.toHaveBeenCalled();
    });

    it("should require a signed-in caller", async () => {
      const res = await testRequest("/api/auth/device/rotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_fingerprint: LEGACY_FP, new_fingerprint: NEW_FP }),
      });
      expect(res.status).toBe(401);
    });
  });
});
