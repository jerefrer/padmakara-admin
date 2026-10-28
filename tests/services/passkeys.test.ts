import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  updateRows: [] as unknown[],
  insertRows: [] as unknown[],
  inserted: [] as unknown[],
  updateSets: [] as unknown[],
  deleteRows: [] as unknown[],
  genReg: vi.fn(),
  verReg: vi.fn(),
  genAuth: vi.fn(),
  verAuth: vi.fn(),
}));

// Every builder step is chainable and awaitable; terminal result depends on the verb.
function chain(rowsOf: () => unknown[], onValues?: (v: unknown) => void, onSet?: (v: unknown) => void) {
  const c: Record<string, unknown> = {};
  const self = () => c;
  for (const k of ["from", "where", "limit", "orderBy", "returning"]) c[k] = vi.fn(self);
  c.values = vi.fn((v: unknown) => { onValues?.(v); return c; });
  c.set = vi.fn((v: unknown) => { onSet?.(v); return c; });
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rowsOf()).then(res, rej);
  return c;
}

vi.mock("../../src/db/index.ts", () => ({
  db: {
    select: vi.fn(() => chain(() => mocks.selectRows)),
    insert: vi.fn(() => chain(() => mocks.insertRows, (v) => mocks.inserted.push(v))),
    update: vi.fn(() => chain(() => mocks.updateRows, undefined, (v) => mocks.updateSets.push(v))),
    delete: vi.fn(() => chain(() => mocks.deleteRows)),
  },
}));

vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: mocks.genReg,
  verifyRegistrationResponse: mocks.verReg,
  generateAuthenticationOptions: mocks.genAuth,
  verifyAuthenticationResponse: mocks.verAuth,
}));

import {
  createRegistrationOptions,
  verifyRegistration,
  createLoginOptions,
  verifyLogin,
} from "../../src/services/passkeys.ts";
import { AppError } from "../../src/lib/errors.ts";

const user = { id: 7, email: "a@b.pt", firstName: "Ana", lastName: "Silva" };
const created = new Date("2026-10-28T10:00:00Z");
const regResponse = { id: "cred-1", rawId: "cred-1", type: "public-key", response: {}, clientExtensionResults: {} } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectRows = [];
  mocks.updateRows = [];
  mocks.insertRows = [];
  mocks.inserted = [];
  mocks.updateSets = [];
  mocks.deleteRows = [];
});

describe("createRegistrationOptions", () => {
  it("should exclude the user's existing keys from registration options", async () => {
    mocks.selectRows = [{ credentialId: "old-1", transports: ["internal"] }];
    mocks.genReg.mockResolvedValue({ challenge: "chal-1" });
    mocks.insertRows = [{ id: "uuid-1" }];

    const out = await createRegistrationOptions(user);

    const arg = mocks.genReg.mock.calls[0]![0];
    expect(arg.excludeCredentials).toEqual([{ id: "old-1", transports: ["internal"] }]);
    expect(arg.attestationType).toBe("none");
    expect(arg.authenticatorSelection).toEqual({ residentKey: "required", userVerification: "required" });
    expect(arg.userName).toBe("a@b.pt");
    expect(arg.userDisplayName).toBe("Ana Silva");
    expect(out.challengeId).toBe("uuid-1");
    expect(mocks.inserted[0]!).toMatchObject({ challenge: "chal-1", userId: 7, purpose: "register" });
  });
});

describe("verifyRegistration", () => {
  it("should store the credential when registration verifies", async () => {
    mocks.updateRows = [{ id: "uuid-1", challenge: "chal-1", userId: 7, purpose: "register" }];
    mocks.verReg.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
      },
    });
    mocks.insertRows = [{ id: 3, name: "iPhone", createdAt: created, lastUsedAt: null }];

    const out = await verifyRegistration(7, "uuid-1", regResponse, "iPhone");

    expect(mocks.verReg.mock.calls[0]![0].expectedChallenge).toBe("chal-1");
    expect(mocks.verReg.mock.calls[0]![0].requireUserVerification).toBe(true);
    expect(mocks.inserted[0]!).toMatchObject({
      userId: 7, credentialId: "cred-1", publicKey: "AQID", counter: 0,
      transports: ["internal"], deviceType: "multiDevice", backedUp: true, name: "iPhone",
    });
    expect(out).toEqual({ id: 3, name: "iPhone", createdAt: created.toISOString(), lastUsedAt: null });
  });

  it("should reject registration with an expired challenge", async () => {
    mocks.updateRows = []; // atomic UPDATE matched nothing: expired
    await expect(verifyRegistration(7, "uuid-1", regResponse, "x")).rejects.toBeInstanceOf(AppError);
    expect(mocks.verReg).not.toHaveBeenCalled();
  });

  it("should reject a challenge used twice", async () => {
    mocks.updateRows = [{ id: "uuid-1", challenge: "chal-1", userId: 7, purpose: "register" }];
    mocks.verReg.mockResolvedValue({ verified: false });
    await expect(verifyRegistration(7, "uuid-1", regResponse, "x")).rejects.toBeInstanceOf(AppError);
    mocks.updateRows = []; // second consumption finds used = true
    await expect(verifyRegistration(7, "uuid-1", regResponse, "x")).rejects.toBeInstanceOf(AppError);
    expect(mocks.verReg).toHaveBeenCalledTimes(1);
  });

  it("should reject a login challenge used for registration", async () => {
    // The purpose is part of the atomic UPDATE's WHERE, so a login challenge matches no row.
    mocks.updateRows = [];
    await expect(verifyRegistration(7, "login-chal", regResponse, "x")).rejects.toBeInstanceOf(AppError);
    expect(mocks.verReg).not.toHaveBeenCalled();
    expect(mocks.inserted).toHaveLength(0);
  });
});

describe("verifyLogin", () => {
  const authResponse = { id: "cred-1", rawId: "cred-1", type: "public-key", response: {}, clientExtensionResults: {} } as never;
  const stored = { id: 3, userId: 7, credentialId: "cred-1", publicKey: "AQID", counter: 4, transports: ["internal"] };

  it("should return the user id and bump counter and last_used_at when login verifies", async () => {
    mocks.updateRows = [{ id: "uuid-2", challenge: "chal-2", purpose: "login" }];
    mocks.selectRows = [stored];
    mocks.verAuth.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 5 } });

    const uid = await verifyLogin("uuid-2", authResponse);

    expect(uid).toBe(7);
    const call = mocks.verAuth.mock.calls[0]![0];
    expect(call.expectedChallenge).toBe("chal-2");
    expect(call.requireUserVerification).toBe(true);
    expect(call.credential).toMatchObject({ id: "cred-1", counter: 4 });
    expect(Array.from(call.credential.publicKey)).toEqual([1, 2, 3]);
    // sets[0] is the challenge consumption, sets[1] the counter bump
    expect(mocks.updateSets[1]!).toMatchObject({ counter: 5 });
    expect((mocks.updateSets[1] as { lastUsedAt: unknown }).lastUsedAt).toBeInstanceOf(Date);
  });

  it("should reject login for an unknown credential id", async () => {
    mocks.updateRows = [{ id: "uuid-2", challenge: "chal-2", purpose: "login" }];
    mocks.selectRows = [];
    await expect(verifyLogin("uuid-2", authResponse)).rejects.toMatchObject({
      statusCode: 401, message: "Passkey sign-in failed",
    });
    expect(mocks.verAuth).not.toHaveBeenCalled();
  });

  it("should reject login when verification fails", async () => {
    mocks.updateRows = [{ id: "uuid-2", challenge: "chal-2", purpose: "login" }];
    mocks.selectRows = [stored];
    mocks.verAuth.mockRejectedValue(new Error("bad signature"));
    await expect(verifyLogin("uuid-2", authResponse)).rejects.toMatchObject({
      statusCode: 401, message: "Passkey sign-in failed",
    });
    expect(mocks.updateSets).toHaveLength(1); // only the challenge consumption
  });
});

describe("createLoginOptions", () => {
  it("should store a login challenge with no user", async () => {
    mocks.genAuth.mockResolvedValue({ challenge: "chal-3" });
    mocks.insertRows = [{ id: "uuid-3" }];
    const out = await createLoginOptions();
    expect(mocks.genAuth.mock.calls[0]![0].userVerification).toBe("required");
    expect(mocks.genAuth.mock.calls[0]![0].allowCredentials).toBeUndefined();
    expect(mocks.inserted[0]!).toMatchObject({ challenge: "chal-3", userId: null, purpose: "login" });
    expect(out.challengeId).toBe("uuid-3");
  });
});
