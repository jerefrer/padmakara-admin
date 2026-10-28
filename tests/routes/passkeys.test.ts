import { describe, it, expect, vi, beforeEach } from "vitest";
import { testJson, testRequest } from "../helpers.ts";

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      userGroupMemberships: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    },
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../../src/services/passkeys.ts", () => ({
  createRegistrationOptions: vi.fn(),
  verifyRegistration: vi.fn(),
  createLoginOptions: vi.fn(),
  verifyLogin: vi.fn(),
  listPasskeys: vi.fn(),
  deletePasskey: vi.fn(),
}));

vi.mock("../../src/services/device-activation.ts", () => ({
  activateDeviceForUser: vi.fn().mockResolvedValue(undefined),
}));

import { db } from "../../src/db/index.ts";
import { AppError } from "../../src/lib/errors.ts";
import { createAccessToken } from "../../src/services/auth.ts";
import { activateDeviceForUser } from "../../src/services/device-activation.ts";
import * as passkeys from "../../src/services/passkeys.ts";

const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111";
const device = {
  device_fingerprint: "fp-1",
  device_name: "Jeremy iPhone",
  device_type: "ios",
};
const loginBody = {
  challengeId: CHALLENGE_ID,
  response: { id: "cred-1", rawId: "cred-1", type: "public-key", response: {} },
  ...device,
};
const dbUser = {
  id: 5, email: "u@test.com", firstName: "U", lastName: "Ser",
  dharmaName: null, preferredLanguage: "en", role: "user",
  isActive: true, isVerified: true,
  subscriptionStatus: "none", subscriptionSource: null, subscriptionExpiresAt: null,
  subscriptionCancelledAt: null, subscriptionAmount: null,
  lastActivity: null, createdAt: new Date(),
};

async function bearer(id = 5) {
  const token = await createAccessToken({ sub: id, email: "u@test.com", role: "user" });
  return { Authorization: `Bearer ${token}` };
}

function insertChain() {
  return { values: vi.fn().mockResolvedValue(undefined) };
}

describe("Passkey routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.insert as any).mockReturnValue(insertChain());
    (db.query.userGroupMemberships.findMany as any).mockResolvedValue([]);
  });

  it("should activate the device and return tokens when login verifies", async () => {
    (passkeys.verifyLogin as any).mockResolvedValue(5);
    (db.query.users.findFirst as any).mockResolvedValue(dbUser);

    const { status, body } = await testJson("/api/auth/passkeys/login/verify", {
      method: "POST",
      headers: { "x-forwarded-for": "1.2.3.4", "user-agent": "UA/1" },
      body: JSON.stringify(loginBody),
    });

    expect(status).toBe(200);
    expect(body.status).toBe("already_activated");
    expect(body.message).toBe("Device is activated");
    expect(body.access_token).toBeDefined();
    expect(body.refresh_token).toBeDefined();
    expect(body.user.email).toBe("u@test.com");
    expect(activateDeviceForUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5 }),
      { fingerprint: "fp-1", name: "Jeremy iPhone", type: "ios", ipAddress: "1.2.3.4", userAgent: "UA/1" },
    );
  });

  it("should return 401 when the passkey user is inactive", async () => {
    (passkeys.verifyLogin as any).mockResolvedValue(5);
    (db.query.users.findFirst as any).mockResolvedValue({ ...dbUser, isActive: false });

    const { status, body } = await testJson("/api/auth/passkeys/login/verify", {
      method: "POST",
      body: JSON.stringify(loginBody),
    });

    expect(status).toBe(401);
    expect(body.error).toBe("Passkey sign-in failed");
    expect(activateDeviceForUser).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("should return 401 when the passkey user no longer exists", async () => {
    (passkeys.verifyLogin as any).mockResolvedValue(5);
    (db.query.users.findFirst as any).mockResolvedValue(undefined);

    const { status, body } = await testJson("/api/auth/passkeys/login/verify", {
      method: "POST",
      body: JSON.stringify(loginBody),
    });

    expect(status).toBe(401);
    expect(body.error).toBe("Passkey sign-in failed");
    expect(activateDeviceForUser).not.toHaveBeenCalled();
  });

  it("should return the same 401 body for every login failure", async () => {
    const post = async () =>
      testJson("/api/auth/passkeys/login/verify", { method: "POST", body: JSON.stringify(loginBody) });

    (passkeys.verifyLogin as any).mockRejectedValueOnce(AppError.unauthorized("Passkey sign-in failed"));
    const badKey = await post();

    (passkeys.verifyLogin as any).mockResolvedValueOnce(5);
    (db.query.users.findFirst as any).mockResolvedValueOnce({ ...dbUser, isActive: false });
    const inactive = await post();

    (passkeys.verifyLogin as any).mockResolvedValueOnce(5);
    (db.query.users.findFirst as any).mockResolvedValueOnce(undefined);
    const deleted = await post();

    for (const r of [badKey, inactive, deleted]) expect(r.status).toBe(401);
    expect(inactive.body).toEqual(badKey.body);
    expect(deleted.body).toEqual(badKey.body);
  });

  it("should reject a non-UUID challengeId with 400 before touching the service", async () => {
    const { status } = await testJson("/api/auth/passkeys/login/verify", {
      method: "POST",
      body: JSON.stringify({ ...loginBody, challengeId: "not-a-uuid" }),
    });
    expect(status).toBe(400);
    expect(passkeys.verifyLogin).not.toHaveBeenCalled();
  });

  it("should require auth for register and list", async () => {
    const paths: [string, string][] = [
      ["POST", "/api/auth/passkeys/register/options"],
      ["POST", "/api/auth/passkeys/register/verify"],
      ["GET", "/api/auth/passkeys"],
      ["DELETE", "/api/auth/passkeys/1"],
    ];
    for (const [method, path] of paths) {
      const res = await testRequest(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      expect(res.status).toBe(401);
    }
    expect(passkeys.createRegistrationOptions).not.toHaveBeenCalled();
    expect(passkeys.listPasskeys).not.toHaveBeenCalled();
  });

  it("should return 404 when deleting another user's passkey", async () => {
    (passkeys.deletePasskey as any).mockResolvedValue(false);

    const res = await testRequest("/api/auth/passkeys/9", {
      method: "DELETE",
      headers: await bearer(5),
    });

    expect(res.status).toBe(404);
    expect(passkeys.deletePasskey).toHaveBeenCalledWith(5, 9);
  });

  it("should return 204 when deleting the caller's own passkey", async () => {
    (passkeys.deletePasskey as any).mockResolvedValue(true);
    const res = await testRequest("/api/auth/passkeys/9", { method: "DELETE", headers: await bearer(5) });
    expect(res.status).toBe(204);
  });

  it("should list only the caller's passkeys", async () => {
    const summary = { id: 1, name: "iPhone", createdAt: "2026-10-28T00:00:00.000Z", lastUsedAt: null };
    (passkeys.listPasskeys as any).mockResolvedValue([summary]);

    const { status, body } = await testJson("/api/auth/passkeys", { headers: await bearer(5) });

    expect(status).toBe(200);
    expect(body).toEqual({ passkeys: [summary] });
    expect(passkeys.listPasskeys).toHaveBeenCalledWith(5);
  });

  it("should return registration options for the signed-in user", async () => {
    (db.query.users.findFirst as any).mockResolvedValue(dbUser);
    (passkeys.createRegistrationOptions as any).mockResolvedValue({ challengeId: CHALLENGE_ID, options: { challenge: "c" } });

    const { status, body } = await testJson("/api/auth/passkeys/register/options", {
      method: "POST",
      headers: await bearer(5),
    });

    expect(status).toBe(200);
    expect(body).toEqual({ challengeId: CHALLENGE_ID, options: { challenge: "c" } });
  });

  it("should store a registered passkey with a default name when none is given", async () => {
    (passkeys.verifyRegistration as any).mockResolvedValue({ id: 1, name: "Passkey", createdAt: "x", lastUsedAt: null });

    const { status, body } = await testJson("/api/auth/passkeys/register/verify", {
      method: "POST",
      headers: await bearer(5),
      body: JSON.stringify({ challengeId: CHALLENGE_ID, response: { id: "c", type: "public-key" } }),
    });

    expect(status).toBe(200);
    expect(body.passkey.id).toBe(1);
    expect(passkeys.verifyRegistration).toHaveBeenCalledWith(5, CHALLENGE_ID, expect.objectContaining({ id: "c" }), "Passkey");
  });

  it("should return login options without auth", async () => {
    (passkeys.createLoginOptions as any).mockResolvedValue({ challengeId: CHALLENGE_ID, options: { challenge: "c" } });
    const { status, body } = await testJson("/api/auth/passkeys/login/options", { method: "POST", body: "{}" });
    expect(status).toBe(200);
    expect(body.challengeId).toBe(CHALLENGE_ID);
  });
});
