/**
 * E2E smoke test — proves the full WS1-A harness works end-to-end.
 *
 * Checks:
 *  1. GET /health  → 200
 *  2. Insert a real user row into padmakara_test via Drizzle
 *  3. POST /api/test/token  → 200 + JWT
 *  4. GET /api/content/progress with Bearer token → 200 (empty array is fine)
 *  5. MinIO round-trip: putObject then getObjectText → content matches
 *
 * Infrastructure is booted by globalSetup (tests/e2e/support/global-setup.ts)
 * and env vars are set by setupFiles (tests/e2e/setup.ts) before any import
 * of src/ modules.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

// These imports resolve AFTER setup.ts has set DATABASE_URL / S3_* env vars,
// because Vitest's setupFiles run before the test module is evaluated.
import { db } from "../../src/db/index.ts";
import { users } from "../../src/db/schema/users.ts";
import { putObject, getObjectText } from "../../src/services/s3.ts";
import { testJson, testRequest } from "../helpers.ts";

// ─── State shared between tests ──────────────────────────────────────────────

let insertedUserId: number;
const TEST_EMAIL = `smoke-e2e-${Date.now()}@test.invalid`;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Insert a minimal user row. Only NOT-NULL columns without defaults need
  // explicit values: email and role. isActive / isVerified default to true /
  // false respectively in the schema, so we set isVerified = true for clarity.
  const [inserted] = await db
    .insert(users)
    .values({
      email: TEST_EMAIL,
      role: "user",
      isActive: true,
      isVerified: true,
    })
    .returning({ id: users.id });

  if (!inserted) {
    throw new Error("Failed to insert test user — no row returned.");
  }
  insertedUserId = inserted.id;
});

afterAll(async () => {
  // Clean up: remove the test user row so the DB stays tidy across runs.
  if (insertedUserId !== undefined) {
    await db.delete(users).where(eq(users.id, insertedUserId));
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("E2E smoke — infrastructure harness", () => {
  it("GET /health returns 200", async () => {
    const res = await testRequest("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("POST /api/test/token returns a JWT for the inserted user", async () => {
    const { status, body } = await testJson<{ token: string }>("/api/test/token", {
      method: "POST",
      body: JSON.stringify({ userId: insertedUserId, email: TEST_EMAIL, role: "user" }),
    });
    expect(status).toBe(200);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
  });

  it("GET /api/content/progress returns 200 with auth token", async () => {
    // Obtain a fresh token for this test.
    const tokenRes = await testJson<{ token: string }>("/api/test/token", {
      method: "POST",
      body: JSON.stringify({ userId: insertedUserId, email: TEST_EMAIL, role: "user" }),
    });
    expect(tokenRes.status).toBe(200);
    const token = tokenRes.body.token;

    const { status, body } = await testJson("/api/content/progress", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
    // A new user has no progress rows — an empty array is the correct response.
    expect(Array.isArray(body)).toBe(true);
  });

  it("MinIO round-trip: putObject then getObjectText returns original content", async () => {
    const key = "e2e-smoke/hello.txt";
    const content = "Hello from the e2e smoke test!";

    await putObject(key, Buffer.from(content, "utf-8"), "text/plain");

    const retrieved = await getObjectText(key);
    expect(retrieved).toBe(content);
  });
});
