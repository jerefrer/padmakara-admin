# WS0 — Critical Security Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two CRITICAL bugs (C1, C2) from the pre-launch security audit — a webhook signature check that crashes instead of rejecting, and a missing error factory that crashes live error paths.

**Architecture:** Two isolated, test-first fixes in `padmakara-api`. C2 adds the missing `AppError.internal` static factory. C1 makes the read-along webhook signature comparison length-safe by mirroring the already-correct `/bunny` webhook handler in the same file. The fixes are independent; either order works.

**Tech Stack:** Hono, Bun, Vitest, Node `crypto`.

**Spec:** `docs/superpowers/specs/2026-05-15-pre-launch-hardening-design.md` (§3).

**Branch:** `fix/critical-security` (off `main`, in the `padmakara-api` repo). No worktree — Phase 1, small.

---

## Conventions for this plan

- **Repo root:** `/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api`
- **Test command** (zoxide hijacks `cd`, so use `sh -c` with an absolute path):
  ```bash
  sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run <test-file>'
  ```
- All `git` commands target the `padmakara-api` repo. Run them from the repo root or with `git -C <repo-root>`.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/lib/errors.ts` | `AppError` class + `errorHandler` | Modify — add `internal` factory |
| `tests/lib/errors.test.ts` | Unit tests for `AppError` factories | Create |
| `src/routes/webhooks.ts` | Read-along + Bunny webhook handlers | Modify — fix read-along signature check (lines 29–36) |
| `tests/routes/webhooks-read-along.test.ts` | Tests for the read-along webhook | Create |

---

## Setup

- [ ] **Step 0: Create the working branch**

```bash
git -C /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api checkout main
git -C /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api checkout -b fix/critical-security
```

Expected: `Switched to a new branch 'fix/critical-security'`.

---

## Task 1: C2 — Add the missing `AppError.internal` factory

**Why:** `AppError.internal(...)` is called in `src/routes/media.ts:249,289,460`, `src/routes/payment.ts:38`, and `src/routes/admin/events.ts:299,345,358`, but the static method does not exist on the class. Every one of those error paths throws `TypeError: AppError.internal is not a function` instead of returning a clean 500.

**Files:**
- Create: `tests/lib/errors.test.ts`
- Modify: `src/lib/errors.ts` (the `AppError` class, after the `conflict` factory on line 32)

- [ ] **Step 1: Write the failing test**

Create `tests/lib/errors.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { AppError } from "../../src/lib/errors.ts";

describe("AppError.internal", () => {
  it("exists as a static factory method", () => {
    expect(typeof AppError.internal).toBe("function");
  });

  it("creates a 500 AppError with the INTERNAL_ERROR code and default message", () => {
    const err = AppError.internal();
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.message).toBe("Internal server error");
  });

  it("accepts a custom message", () => {
    const err = AppError.internal("S3 fetch failed");
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.message).toBe("S3 fetch failed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/lib/errors.test.ts'
```

Expected: FAIL — `AppError.internal` is `undefined`, so the first test fails on `expect(typeof ...).toBe("function")` and the others throw `TypeError`.

- [ ] **Step 3: Add the `internal` factory**

In `src/lib/errors.ts`, add this method to the `AppError` class immediately after the `conflict` method (currently lines 30–32):

```typescript
  static internal(message = "Internal server error") {
    return new AppError(500, message, "INTERNAL_ERROR");
  }
```

The class block now ends:

```typescript
  static conflict(message: string) {
    return new AppError(409, message, "CONFLICT");
  }

  static internal(message = "Internal server error") {
    return new AppError(500, message, "INTERNAL_ERROR");
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/lib/errors.test.ts'
```

Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api add src/lib/errors.ts tests/lib/errors.test.ts
git -C /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api commit -m "fix(api): add missing AppError.internal factory method" -m "Fixes C2 from the pre-launch security audit: AppError.internal was called in media.ts, payment.ts and admin/events.ts but never defined, crashing those error paths with a TypeError." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: C1 — Make the read-along webhook signature check length-safe

**Why:** `src/routes/webhooks.ts:34` calls `timingSafeEqual(Buffer.from(signature), Buffer.from(expected))`. Node's `crypto.timingSafeEqual` throws `RangeError` when the two buffers differ in length. An attacker sending an `X-Webhook-Signature` header of the wrong length triggers an unhandled throw → the request returns a generic 500 instead of a clean 401, and the rejection logic is not robust. The `/bunny` handler in the same file (lines 111–113 and 125–129) already does this correctly by comparing lengths first.

**Files:**
- Create: `tests/routes/webhooks-read-along.test.ts`
- Modify: `src/routes/webhooks.ts` (lines 29–36, inside the `POST /read-along` handler)

- [ ] **Step 1: Write the failing test**

Create `tests/routes/webhooks-read-along.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { config } from "../../src/config.ts";
import { testRequest } from "../helpers.ts";

// The read-along handler updates the readAlongJobs row after a valid signature.
// Mock the db so the valid-signature test does not need a real database.
vi.mock("../../src/db/index.ts", () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
    query: { tracks: { findFirst: vi.fn() } },
  },
}));

function sign(rawBody: string): string {
  return createHmac("sha256", config.readAlong.webhookSecret)
    .update(rawBody)
    .digest("hex");
}

async function postReadAlong(
  body: Record<string, unknown>,
  signature?: string,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature !== undefined) headers["X-Webhook-Signature"] = signature;
  return testRequest("/api/webhooks/read-along", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

describe("POST /api/webhooks/read-along — signature verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the signature header is missing", async () => {
    const res = await postReadAlong({ jobId: "j1", status: "failed" });
    expect(res.status).toBe(401);
  });

  it("returns 401 (not 500) for a short, wrong-length signature", async () => {
    // Pre-fix this crashes: timingSafeEqual throws RangeError on length mismatch.
    const res = await postReadAlong({ jobId: "j1", status: "failed" }, "x");
    expect(res.status).toBe(401);
  });

  it("returns 401 for a same-length but incorrect signature", async () => {
    const res = await postReadAlong({ jobId: "j1", status: "failed" }, "0".repeat(64));
    expect(res.status).toBe(401);
  });

  it("accepts a valid signature and returns 200", async () => {
    const body = { jobId: "j1", status: "failed" };
    const res = await postReadAlong(body, sign(JSON.stringify(body)));
    expect(res.status).toBe(200);
  });
});
```

Note: `status: "failed"` is used so the handler updates the job row and skips the `status === "completed"` track-update loop — keeping the valid-signature path simple. The signature is generated from the same `config.readAlong.webhookSecret` the handler uses, so the test is correct regardless of the test environment's secret value.

- [ ] **Step 2: Run the test to verify it fails**

```bash
sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/webhooks-read-along.test.ts'
```

Expected: FAIL — the test `"returns 401 (not 500) for a short, wrong-length signature"` fails because `timingSafeEqual` throws on the length mismatch and the request resolves to `500`.

- [ ] **Step 3: Fix the signature check**

In `src/routes/webhooks.ts`, replace lines 29–36 (from `const rawBody = await c.req.text();` through the closing `}` of the signature `if`):

```typescript
  const rawBody = await c.req.text();
  const expected = createHmac("sha256", config.readAlong.webhookSecret)
    .update(rawBody)
    .digest("hex");

  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return c.json({ error: "Invalid signature" }, 401);
  }
```

with:

```typescript
  const rawBody = await c.req.text();
  const expected = createHmac("sha256", config.readAlong.webhookSecret)
    .update(rawBody)
    .digest("hex");

  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (
    signatureBuf.length !== expectedBuf.length ||
    !timingSafeEqual(signatureBuf, expectedBuf)
  ) {
    return c.json({ error: "Invalid signature" }, 401);
  }
```

This mirrors the `/bunny` handler's correct pattern (length check before `timingSafeEqual`).

- [ ] **Step 4: Run the test to verify it passes**

```bash
sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run tests/routes/webhooks-read-along.test.ts'
```

Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api add src/routes/webhooks.ts tests/routes/webhooks-read-along.test.ts
git -C /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api commit -m "fix(api): make read-along webhook signature check length-safe" -m "Fixes C1 from the pre-launch security audit: crypto.timingSafeEqual throws RangeError on length-mismatched buffers, so a wrong-length X-Webhook-Signature crashed the handler (500) instead of returning 401. Compare buffer lengths first, mirroring the /bunny handler." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Step F1: Run the full test suite to confirm nothing regressed**

```bash
sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun node_modules/.bin/vitest run'
```

Expected: PASS — the whole suite is green, including the two new test files.

- [ ] **Step F2: Type-check**

```bash
sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api && /Users/jeremy/.bun/bin/bun run typecheck'
```

Expected: no errors.

---

## Done criteria

- `AppError.internal` exists and returns a 500 `AppError` with code `INTERNAL_ERROR`.
- The read-along webhook returns `401` (never `500`/crash) for missing, short, or wrong-length signatures, and `200` for a valid one.
- Full test suite green, typecheck clean.
- Two commits on `fix/critical-security`.
- Branch is left ready to merge to `main` (merge handled after review, outside this plan).
