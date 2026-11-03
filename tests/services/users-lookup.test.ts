import { describe, it, expect, vi, beforeEach } from "vitest";

const limit = vi.fn();
const returning = vi.fn();
const values = vi.fn();
const where = vi.fn();

vi.mock("../../src/db/index.ts", () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: (...a: unknown[]) => { where(...a); return { limit }; } })) })),
    insert: vi.fn(() => ({
      values: (...a: unknown[]) => {
        values(...a);
        return { onConflictDoNothing: () => ({ returning }) };
      },
    })),
  },
}));

import { findOrCreateUserByEmail } from "../../src/services/users-lookup.ts";

beforeEach(() => vi.clearAllMocks());

describe("findOrCreateUserByEmail", () => {
  it("should reuse the existing user when the email differs by case and whitespace", async () => {
    limit.mockResolvedValueOnce([{ id: 4, email: "Foo@x.pt", preferredLanguage: "pt" }]);
    const r = await findOrCreateUserByEmail({ email: "  Foo@X.pt ", language: "en" });
    expect(r).toEqual({ user: { id: 4, email: "Foo@x.pt", preferredLanguage: "pt" }, created: false });
    expect(values).not.toHaveBeenCalled();
  });

  it("should create an active, unverified, normal user with a trimmed lowercase email", async () => {
    limit.mockResolvedValueOnce([]);
    returning.mockResolvedValueOnce([{ id: 9, email: "foo@x.pt", preferredLanguage: "pt" }]);
    const r = await findOrCreateUserByEmail({ email: "  Foo@X.pt ", firstName: "Foo", lastName: "Bar", language: "pt" });
    expect(r.created).toBe(true);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "foo@x.pt", firstName: "Foo", lastName: "Bar", isActive: true,
        isVerified: false, role: "user", preferredLanguage: "pt",
      }),
    );
  });

  it("should reuse the winner when a concurrent insert took the email", async () => {
    limit.mockResolvedValueOnce([]);
    returning.mockResolvedValueOnce([]);
    limit.mockResolvedValueOnce([{ id: 12, email: "foo@x.pt", preferredLanguage: "en" }]);
    const r = await findOrCreateUserByEmail({ email: "foo@x.pt", language: "en" });
    expect(r).toEqual({ user: { id: 12, email: "foo@x.pt", preferredLanguage: "en" }, created: false });
  });
});
