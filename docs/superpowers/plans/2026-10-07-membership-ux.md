# Membership Payment UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the draft subscription screens with the full membership journey of the approved mockup: locked content, contribution choice, Easypay checkout, truthful outcome screens, a membership management page and transactional emails.

**Architecture:** The API (Hono/Bun, worktree `padmakara-api-membership`, branch `feature/membership-ux`) gains pure membership helpers, richer checkout creation, read/manage endpoints, emails, a preview endpoint for locked events, and a localized checkout page. The app (Expo Router, worktree `padmakara-app-membership`, branch `feature/membership-ux`) gains a `membershipService`, a `/membership` route group (join, manage, confirming, closed, terms) and locked-state entry points, all web-only for money, with a reader-safe native variant.

**Tech Stack:** API: Bun, Hono, Drizzle, Zod v4, Vitest (`bunx --bun vitest run`). App: Expo Router v5, React Native + web, jest-expo (`npx jest`), i18n JSON in `locales/en.json` + `locales/pt.json`.

**Spec:** `docs/superpowers/specs/2026-10-07-membership-ux-design.md` (decisions D1–D15) and the visual reference `docs/superpowers/specs/2026-10-07-membership-ux-mockup.html` (screens 1–14). Both live in the API worktree.

## Global Constraints

- API worktree: `/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api-membership`. App worktree: `/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-app-membership`. Never edit `padmakara-api/` or `padmakara-app/` (they hold someone's uncommitted work).
- Run API tests with `bunx --bun vitest run` (plain `bun run test` / Node vitest fails on `Bun is not defined` in some suites). Typecheck: `bun run typecheck`; 4 errors pre-exist in `src/routes/admin/publications.ts` and `src/routes/media.ts` — do not add new ones.
- Run app tests with `npx jest <path>`; app typecheck `npx tsc --noEmit` (compare error count before/after; add none).
- Zoxide hijacks `cd`: use `sh -c 'cd /path && cmd'` or absolute paths.
- No new DB migration in this plan (the API repo has an uncommitted `0038` elsewhere; adding one would collide).
- UI words: membership / member / contribution — PT adesão / membro / contribuição. **Never** "subscription", "subscribe", "subscrição", "subscrever", "assinatura" in any new or touched locale string.
- Native (Platform.OS !== 'web') never renders a price, a join/pay button, or a link to the website.
- Amounts: monthly min 5, yearly min 60, max 1000, at most 2 decimals, EUR.
- Easypay frequencies: monthly `"1M"`, yearly `"1Y"`. Checkout `methods: ["cc", "dd"]`. Card descriptor ASCII: `"Padmakara membership"`.
- Every new user-facing app string goes through `t('membership.<key>') || '<English fallback>'` with the key present in both `en.json` and `pt.json` (a parity test exists: `locales/locales.test.ts`).
- Commit after each task in its own worktree, Conventional Commits, ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014fTT7HioX2cCSYhm9BZxWp
  ```
- Do not push, deploy or merge. The controller does that after review.

## Review Focus

1. **Amount tampering** — a client posting `amount: 1` or `"abc"` or `5.555` to join/change-amount must get 400; the server is the only judge of the floor (Task 1, Task 5 tests).
2. **Webhook ordering** — `subscription_create` (tokenized) arrives ~20–50 s before the capture; it must never grant access, and for a card update it must swap the stored subscription id and deactivate the old one exactly once (Task 3 tests).
3. **Resume after expiry / cancel twice** — resuming when access already ended must 400 with a message telling the member to join again; cancelling an already-cancelled membership must be idempotent (Task 5 tests).
4. **Native leakage** — the join screen, prices and the website link must not render on iOS/Android even if the `/membership` URL is opened by deep link (Task 9/12 tests: render with `Platform.OS = 'ios'`).
5. **Polling never ends** — the confirming screen must stop polling on unmount and after 3 minutes, and must not crash when the checkout id is missing from the URL (Task 10 test).

---

## API (worktree `padmakara-api-membership`)

### Task 1: Membership helpers + join endpoint accepts amount and interval

**Files:**
- Create: `src/services/membership.ts`
- Create: `tests/services/membership.test.ts`
- Modify: `src/routes/payment.ts` (the `/subscribe` handler, `nextExpiry`, mock helpers)
- Modify: `tests/routes/payment-webhook.test.ts` (the existing `POST /api/payment/subscribe (real Easypay)` describe)
- Modify: `tests/routes/payment.test.ts` (mock-mode subscribe tests send a body)

**Interfaces:**
- Produces (`src/services/membership.ts`):
  ```ts
  export type MembershipInterval = "month" | "year";
  export const MIN_AMOUNT: Record<MembershipInterval, number>; // { month: 5, year: 60 }
  export const MAX_AMOUNT = 1000;
  export function parseContribution(amount: unknown, interval: unknown):
    { ok: true; amount: number; interval: MembershipInterval } | { ok: false; error: string };
  export function frequencyFor(interval: MembershipInterval): "1M" | "1Y";
  export function intervalFromFrequency(frequency: string | undefined | null): MembershipInterval; // "1Y" → "year", anything else → "month"
  export function addInterval(date: Date, interval: MembershipInterval): Date; // returns a new Date
  export function nextExpiry(current: Date | null, interval: MembershipInterval, now?: Date): Date;
  export function easypayDateTime(d: Date): string; // "YYYY-MM-DD HH:MM" in UTC
  ```
- Produces (HTTP): `POST /api/payment/subscribe` body `{ amount: number, interval: "month"|"year", language?: "en"|"pt" }` → `{ url }`. Checkout page URL now carries `&amount=<n>&interval=<month|year>&lang=<en|pt>`.

- [ ] **Step 1: Write the failing helper tests** — `tests/services/membership.test.ts`:
  ```ts
  import { describe, it, expect } from "vitest";
  import {
    parseContribution, frequencyFor, intervalFromFrequency, addInterval, nextExpiry, easypayDateTime,
  } from "../../src/services/membership.ts";

  describe("parseContribution", () => {
    it("should accept the monthly floor", () => {
      expect(parseContribution(5, "month")).toEqual({ ok: true, amount: 5, interval: "month" });
    });
    it("should accept a yearly amount of 60", () => {
      expect(parseContribution(60, "year")).toEqual({ ok: true, amount: 60, interval: "year" });
    });
    it("should accept a numeric string with two decimals", () => {
      expect(parseContribution("12.50", "month")).toEqual({ ok: true, amount: 12.5, interval: "month" });
    });
    it.each([
      [4.99, "month"], [59, "year"], [1000.01, "month"], [5.555, "month"],
      ["abc", "month"], [null, "month"], [NaN, "month"], [Infinity, "year"], [-5, "month"],
    ])("should reject amount %s for %s", (amount, interval) => {
      expect(parseContribution(amount, interval).ok).toBe(false);
    });
    it("should reject an unknown interval", () => {
      expect(parseContribution(10, "week").ok).toBe(false);
    });
  });

  describe("intervals", () => {
    it("should map intervals to Easypay frequencies and back", () => {
      expect(frequencyFor("month")).toBe("1M");
      expect(frequencyFor("year")).toBe("1Y");
      expect(intervalFromFrequency("1Y")).toBe("year");
      expect(intervalFromFrequency("1M")).toBe("month");
      expect(intervalFromFrequency(undefined)).toBe("month");
    });
    it("should add one month or one year without mutating the input", () => {
      const d = new Date("2026-10-07T12:00:00Z");
      expect(addInterval(d, "month").toISOString()).toBe("2026-11-07T12:00:00.000Z");
      expect(addInterval(d, "year").toISOString()).toBe("2027-10-07T12:00:00.000Z");
      expect(d.toISOString()).toBe("2026-10-07T12:00:00.000Z");
    });
  });

  describe("nextExpiry", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    it("should extend from now when there is no current expiry", () => {
      expect(nextExpiry(null, "month", now).toISOString()).toBe("2026-11-07T12:00:00.000Z");
    });
    it("should extend from a future expiry, not from now", () => {
      const cur = new Date("2026-10-20T00:00:00Z");
      expect(nextExpiry(cur, "month", now).toISOString()).toBe("2026-11-20T00:00:00.000Z");
    });
    it("should extend from now when the expiry is in the past", () => {
      const cur = new Date("2026-01-01T00:00:00Z");
      expect(nextExpiry(cur, "year", now).toISOString()).toBe("2027-10-07T12:00:00.000Z");
    });
  });

  it("should format Easypay datetimes in UTC", () => {
    expect(easypayDateTime(new Date("2026-11-07T13:56:42Z"))).toBe("2026-11-07 13:56");
  });
  ```

- [ ] **Step 2: Run** `bunx --bun vitest run tests/services/membership.test.ts` — expect FAIL (module not found).

- [ ] **Step 3: Implement** `src/services/membership.ts`:
  ```ts
  /**
   * Pure membership rules shared by the payment routes: contribution bounds, Easypay
   * frequency mapping and access-period arithmetic. See the design doc D1–D5.
   */
  export type MembershipInterval = "month" | "year";

  export const MIN_AMOUNT: Record<MembershipInterval, number> = { month: 5, year: 60 };
  export const MAX_AMOUNT = 1000;

  export function parseContribution(
    amount: unknown,
    interval: unknown,
  ): { ok: true; amount: number; interval: MembershipInterval } | { ok: false; error: string } {
    if (interval !== "month" && interval !== "year") {
      return { ok: false, error: "Interval must be month or year" };
    }
    const value = typeof amount === "string" ? Number(amount) : amount;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: "Amount must be a number" };
    }
    if (Math.round(value * 100) !== value * 100) {
      return { ok: false, error: "Amount can have at most two decimals" };
    }
    const min = MIN_AMOUNT[interval];
    if (value < min) return { ok: false, error: `Minimum contribution is €${min}` };
    if (value > MAX_AMOUNT) return { ok: false, error: `Maximum contribution is €${MAX_AMOUNT}` };
    return { ok: true, amount: value, interval };
  }

  export function frequencyFor(interval: MembershipInterval): "1M" | "1Y" {
    return interval === "year" ? "1Y" : "1M";
  }

  export function intervalFromFrequency(frequency: string | undefined | null): MembershipInterval {
    return frequency === "1Y" ? "year" : "month";
  }

  export function addInterval(date: Date, interval: MembershipInterval): Date {
    const d = new Date(date);
    if (interval === "year") d.setUTCFullYear(d.getUTCFullYear() + 1);
    else d.setUTCMonth(d.getUTCMonth() + 1);
    return d;
  }

  /**
   * Extend from the later of now and the current paid-through date: an early renewal
   * must not shorten the paid period, a late one must not swallow the days it was late.
   */
  export function nextExpiry(current: Date | null, interval: MembershipInterval, now = new Date()): Date {
    const base = current && current > now ? current : now;
    return addInterval(base, interval);
  }

  export function easypayDateTime(d: Date): string {
    return d.toISOString().replace("T", " ").slice(0, 16);
  }
  ```

- [ ] **Step 4: Run** the helper tests — expect PASS.

- [ ] **Step 5: Rewire `/subscribe`** in `src/routes/payment.ts`:
  - Delete the local `nextExpiry` function; import `{ parseContribution, frequencyFor, addInterval, easypayDateTime, type MembershipInterval }` from `../services/membership.ts`.
  - At the top of the handler (after loading `user` and the `hasActiveSubscription` guard), parse the body:
    ```ts
    const body = await c.req.json().catch(() => ({}));
    const parsed = parseContribution(body?.amount, body?.interval);
    if (!parsed.ok) throw AppError.badRequest(parsed.error, "INVALID_CONTRIBUTION");
    const { amount, interval } = parsed;
    const language = body?.language === "pt" ? "pt" : "en";
    ```
  - Mock mode: `mockCreateSubscription(user.id, amount, interval)` sets `subscriptionExpiresAt = addInterval(new Date(), interval)` and `subscriptionAmount: String(amount)`; return `url: \`${config.urls.frontend}/membership/confirming?checkout=mock_session\``.
  - Real mode payload (replace the existing literal):
    ```ts
    const label = interval === "year" ? "Padmakara membership (yearly)" : "Padmakara membership (monthly)";
    payment: {
      methods: ["cc", "dd"],
      type: "sale",
      capture: { descriptive: "Padmakara membership" },
      currency: "EUR",
      start_time: easypayDateTime(addInterval(new Date(), interval)),
      frequency: frequencyFor(interval),
      expiration_time: "2030-12-31 23:59",
      capture_now: true,
      retries: 2,
    },
    order: {
      items: [{ description: label, quantity: 1, key: `padmakara-membership-user-${user.id}`, value: amount }],
      key: `user-${user.id}-${Date.now()}`,
      value: amount,
    },
    ```
    Keep the existing `customer` block and the comment explaining D3 (one interval later, double-charge otherwise).
  - Return URL: `${config.urls.backend}/api/payment/checkout/${checkoutData.id}?session=${encodeURIComponent(checkoutData.session)}&amount=${amount}&interval=${interval}&lang=${language}`.
  - In the webhook payment branch replace `nextExpiry(user.subscriptionExpiresAt)` with `nextExpiry(user.subscriptionExpiresAt, intervalFromFrequency(subscription.frequency as string | undefined))`; add `frequency?: string` to `EasypaySubscriptionResponse`.

- [ ] **Step 6: Update route tests.** In `tests/routes/payment-webhook.test.ts`, in the `POST /api/payment/subscribe (real Easypay)` describe: send `body: JSON.stringify({ amount: 10, interval: "month" })` in the existing test and also assert `sent.payment.frequency === "1M"`, `sent.order.value === 10`, `sent.payment.capture.descriptive === "Padmakara membership"`. Add:
  ```ts
  it("should create a yearly membership starting its cycle a year later", async () => {
    // same fetch mock + token as the existing test
    const { status } = await testJson("/api/payment/subscribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: 120, interval: "year" }),
    });
    expect(status).toBe(200);
    const sent = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(sent.payment.frequency).toBe("1Y");
    const days = (new Date(sent.payment.start_time.replace(" ", "T") + ":00Z").getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(360);
  });

  it.each([[{ amount: 1, interval: "month" }], [{ amount: 50, interval: "year" }], [{ amount: "x", interval: "month" }], [{}]])(
    "should reject an invalid contribution %j with 400 and no Easypay call",
    async (payload) => {
      const res = await testJson("/api/payment/subscribe", {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_CONTRIBUTION");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("should carry amount, interval and language on the checkout page URL", async () => {
    const res = await testJson("/api/payment/subscribe", {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: 10, interval: "month", language: "pt" }),
    });
    expect(res.body.url).toContain("amount=10&interval=month&lang=pt");
  });
  ```
  (Hoist `fetchMock` and `token` creation into a `beforeEach` of that describe so every test shares them.) In `tests/routes/payment.test.ts` make every `/api/payment/subscribe` call send `body: JSON.stringify({ amount: 5, interval: "month" })`, and change the mock-mode URL assertions from `/subscription/success` to `/membership/confirming`.

- [ ] **Step 7: Run** `bunx --bun vitest run` (all) and `bun run typecheck` — all green, no new type errors.

- [ ] **Step 8: Commit** `feat(payments): accept a chosen amount and a monthly or yearly interval`.

---

### Task 2: Specific access-denial codes and a locked-event preview

**Files:**
- Modify: `src/services/access.ts` (`denialToHttpError`)
- Modify: `src/routes/events.ts` (add `GET /:id/preview` **before** the `GET /:id` route so it is not shadowed)
- Test: `tests/services/access.test.ts`, `tests/routes/events.test.ts`

**Interfaces:**
- Produces: 401/403 bodies `{ error, code }` with `code` one of `AUTH_REQUIRED`, `SUBSCRIPTION_REQUIRED`, `GROUP_MEMBERSHIP_REQUIRED`, `EVENT_ATTENDANCE_REQUIRED`, `ACCESS_DENIED` (404 for `STATUS_HIDDEN` unchanged, code `NOT_FOUND`).
- Produces: `GET /api/events/:id/preview` (no auth) → 200 `EventPreview` or 404:
  ```ts
  interface EventPreview {
    id: number; titleEn: string | null; titlePt: string | null;
    startDate: string | null; endDate: string | null;
    imageUrl: string | null;          // same field the public detail endpoint exposes for the hero, resolved the same way
    teachers: { name: string }[];
    sessionCount: number;
    audience: "free-subscribers";
  }
  ```

- [ ] **Step 1: Failing tests.** In `tests/services/access.test.ts` `denialToHttpError` describe, add:
  ```ts
  it.each([
    ["AUTH_REQUIRED", 401, "AUTH_REQUIRED"],
    ["SUBSCRIPTION_REQUIRED", 403, "SUBSCRIPTION_REQUIRED"],
    ["GROUP_MEMBERSHIP_REQUIRED", 403, "GROUP_MEMBERSHIP_REQUIRED"],
    ["EVENT_ATTENDANCE_REQUIRED", 403, "EVENT_ATTENDANCE_REQUIRED"],
    ["ACCESS_DENIED", 403, "ACCESS_DENIED"],
  ] as const)("should give %s status %i and code %s", (reason, status, code) => {
    try { denialToHttpError(reason); } catch (e: any) {
      expect(e.statusCode).toBe(status);
      expect(e.code).toBe(code);
      return;
    }
    throw new Error("did not throw");
  });
  ```
  In `tests/routes/events.test.ts` (follow its existing db-mock style) add tests: preview of a published `free-subscribers` event → 200 with `id`, `titleEn`, `sessionCount`, and **no** `sessions` key; preview of a `retreat-group-members` event → 404; preview of a draft event → 404; preview of a missing id → 404.
- [ ] **Step 2: Run** them — FAIL.
- [ ] **Step 3: Implement.** In `denialToHttpError` use `new AppError(401, "Authentication required", "AUTH_REQUIRED")` and `new AppError(403, "<existing message>", "<REASON>")` for each 403 reason (`default` → `"ACCESS_DENIED"`). In `events.ts`, add the preview route: load with `db.query.events.findFirst({ where: and(eq(events.id, id), eq(events.status, "published")), with: <the same relations the public detail uses for audience + teachers + sessions> })`; return 404 unless `event.audience?.slug === AUDIENCE_SLUGS.SUBSCRIBERS`; resolve the hero image exactly like `/public/:id` does (reuse `resolveEventTeacherUrls` etc. as needed, read that handler first); build and return the `EventPreview` object explicitly field by field — never spread the event, so no track keys, S3 keys or video ids leak.
- [ ] **Step 4: Run** all API tests + typecheck — green.
- [ ] **Step 5: Commit** `feat(events): name the access-denial reason and preview locked member retreats`.

---

### Task 3: Webhook handles card updates and the yearly interval

**Files:**
- Modify: `src/routes/payment.ts` (webhook)
- Test: `tests/routes/payment-webhook.test.ts`

**Interfaces:**
- Consumes: `intervalFromFrequency`, `nextExpiry` (Task 1).
- Produces: notification type `subscription_create` + status `success`:
  - user has **no** `easypaySubscriptionId` → store the new id, grant nothing, ledger action `"tokenized"`;
  - user has the **same** id → ledger `"tokenized"`, nothing else;
  - user has a **different** id → `PATCH /subscription/<old> {status:"inactive"}` (best effort, log on failure), store the new id, clear `subscriptionCancelledAt`, ledger action `"method_updated"`.
  Add `"subscription_create"` handling **before** `classifyNotification`, so it never reaches the payment branch.

- [ ] **Step 1: Failing tests** in the `POST /api/payment/webhook (real Easypay)` describe:
  ```ts
  const create = { id: "sub-new", key: "", type: "subscription_create", status: "success", messages: [], date: "2026-10-07 14:06:15" };

  it("should not grant access on subscription_create", async () => {
    stubEasypay(easypaySubscription({ id: "sub-new" }));
    await notify(create);
    expect(usersUpdate()?.subscriptionStatus).toBeUndefined();
    expect(ledgerUpdate()).toMatchObject({ action: "tokenized" });
  });

  it("should swap the stored subscription and deactivate the old one on a card update", async () => {
    (db.query.users.findFirst as any).mockResolvedValue({
      id: 7, subscriptionStatus: "active", subscriptionExpiresAt: new Date(Date.now() + 10 * 86_400_000),
      subscriptionAmount: "10", easypaySubscriptionId: "sub-old", subscriptionCancelledAt: null,
    });
    stubEasypay(easypaySubscription({ id: "sub-new" }));
    await notify(create);
    const calls = (global.fetch as any).mock.calls.map((c: any[]) => [c[0], c[1]?.method]);
    expect(calls).toContainEqual([expect.stringContaining("/subscription/sub-old"), "PATCH"]);
    expect(usersUpdate()).toMatchObject({ easypaySubscriptionId: "sub-new", subscriptionCancelledAt: null });
    expect(ledgerUpdate()).toMatchObject({ action: "method_updated" });
  });

  it("should extend a yearly member by a year", async () => {
    stubEasypay(easypaySubscription({ frequency: "1Y" }));
    await notify(capture);
    const days = ((usersUpdate()!.subscriptionExpiresAt as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(360);
  });
  ```
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the `subscription_create` branch right after the user is resolved:
  ```ts
  if ((type ?? "").toLowerCase() === "subscription_create" && (status ?? "").toLowerCase() === "success") {
    const previous = user.easypaySubscriptionId;
    if (previous && previous !== id) {
      await easypayFetch(`/subscription/${previous}`, { method: "PATCH", body: JSON.stringify({ status: "inactive" }) })
        .catch((err) => console.error(`[EASYPAY WEBHOOK] could not deactivate replaced subscription ${previous}:`, err));
      await db.update(users)
        .set({ easypaySubscriptionId: id, subscriptionCancelledAt: null, updatedAt: new Date() })
        .where(eq(users.id, userId));
      await recordOutcome({ ...common, action: "method_updated", note: `replaced ${previous}` });
      return c.json({ received: true });
    }
    if (!previous) {
      await db.update(users).set({ easypaySubscriptionId: id, updatedAt: new Date() }).where(eq(users.id, userId));
    }
    // A stored card or a signed mandate is not money: access waits for the capture (D4).
    await recordOutcome({ ...common, action: "tokenized" });
    return c.json({ received: true });
  }
  ```
  `stubEasypay` returns the same payload for every fetch call; the PATCH in the test resolves to it — that is fine.
- [ ] **Step 4: Run** all API tests + typecheck — green.
- [ ] **Step 5: Commit** `feat(payments): handle card replacement and yearly renewals in the webhook`.

---

### Task 4: Membership read endpoints and richer `/auth/me`

**Files:**
- Modify: `src/routes/payment.ts` (add `GET /membership`, `GET /checkout-status/:id`)
- Modify: `src/routes/auth.ts` (`formatUserForApp`, ~line 48–94)
- Test: `tests/routes/payment-membership.test.ts` (create; copy the env/`vi.hoisted`/db-mock/`stubEasypay` scaffolding from `payment-webhook.test.ts`, adding `select`/`from`/`where`/`orderBy`/`limit` chain mocks for the ledger query), `tests/routes/auth.test.ts`

**Interfaces:**
- Produces `GET /api/payment/membership` (auth) →
  ```ts
  interface MembershipView {
    state: "none" | "active" | "cancelled" | "payment_failed" | "lapsed";
    source: "easypay" | "admin" | "cash" | "bank_transfer" | null;
    amount: number | null;                 // from users.subscriptionAmount
    interval: "month" | "year" | null;     // from the Easypay subscription frequency, null if not Easypay
    accessUntil: string | null;            // ISO, users.subscriptionExpiresAt
    graceUntil: string | null;             // accessUntil + graceDays, ISO, only when state === "payment_failed"
    cancelledAt: string | null;
    method: { type: "card" | "direct_debit"; lastFour: string | null; brand: string | null } | null;
    history: { date: string; amount: number | null; outcome: "paid" | "failed" | "refunded" }[]; // newest first, max 12
  }
  ```
  Rules: `none` when `subscriptionStatus === "none"` and no expiry; `lapsed` when `!hasActiveSubscription(user)`; `cancelled` when access is active and `subscriptionCancelledAt` set; `payment_failed` when access is active, not cancelled, and the newest ledger row for the user with `notificationType` in (`subscription_capture`,`capture`) has `action === "ignored"` and `note === "payment_failed"`; else `active`. `method`/`interval` come from `GET /subscription/<easypaySubscriptionId>` only when source is `easypay` and the id does not start with `mock_`; on Easypay error return them as `null` (never 500 the page). History from `payment_transactions` rows of this user whose `notificationType` is `subscription_capture` or `capture`: `activated`/`extended` → `paid`, `ignored` with note `payment_failed` → `failed`, `reversed` → `refunded`.
- Produces `GET /api/payment/checkout-status/:id` (auth) → `{ state: "active" | "processing" | "failed" | "pending", method: "card" | "direct_debit" | null }`: `active` if `hasActiveSubscription(user)`; else read `GET /checkout/:id` from Easypay: `payment.status` `failed`/`error`/`deleted` → `failed`; `method.type` dd (case-insensitive) → `processing`; otherwise `pending`. Mock mode: `active` if access else `pending`.
- Produces in `formatUserForApp` → `subscription: { status, source, expiresAt, cancelledAt: string|null, amount: number|null, hasAccess: boolean }` (`hasAccess = hasActiveSubscription(user)`). Add `subscriptionCancelledAt` and `subscriptionAmount` to the function's parameter type.

- [ ] **Step 1: Failing tests** — one test per `state` value (5), one for Easypay error → `method: null` and still 200, history mapping (paid/failed/refunded, newest first), 401 without token; checkout-status: active user → `active` with no Easypay call; dd pending → `processing`; failed → `failed`; cc pending → `pending`. In `auth.test.ts` assert `/api/auth/me` returns `subscription.hasAccess === true` for a user expired 3 days ago (grace) and `false` for 30 days ago.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** both handlers with `authMiddleware`; extract a pure `membershipState(user, lastCapture): MembershipView["state"]` function at module level in `payment.ts` and unit-test it directly in the same test file.
- [ ] **Step 4: Run** all API tests + typecheck — green.
- [ ] **Step 5: Commit** `feat(payments): expose membership status, history and checkout progress`.

---

### Task 5: Manage endpoints — change amount, resume, update payment method, idempotent cancel

**Files:**
- Modify: `src/routes/payment.ts`
- Test: `tests/routes/payment-manage.test.ts` (create, same scaffolding as Task 4)

**Interfaces:**
- Produces (all `authMiddleware`, all 400 with `code` on rule violations):
  - `POST /api/payment/amount` `{ amount }` → `{ amount }`. Requires source `easypay`, a real (non-mock) subscription id and access; interval from the Easypay subscription frequency; validates with `parseContribution`; `PATCH /subscription/<id> {value: amount}`; sets `subscriptionAmount`. Codes: `NOT_EASYPAY_MEMBER`, `INVALID_CONTRIBUTION`.
  - `POST /api/payment/resume` → `{ accessUntil }`. Requires `subscriptionCancelledAt` set and `hasActiveSubscription`; `PATCH /subscription/<id> {status:"active", frequency:<from subscription>, start_time: easypayDateTime(subscriptionExpiresAt)}`; clears `subscriptionCancelledAt`. Codes: `NOT_CANCELLED`, `ACCESS_ENDED` (message: "Your membership has ended. Please join again.").
  - `POST /api/payment/update-method` `{ language? }` → `{ url }`. Requires source `easypay`. Reads amount/interval from the current Easypay subscription (fallback: `subscriptionAmount`, month). If `hasActiveSubscription`: `capture_now: false`, `start_time: easypayDateTime(subscriptionExpiresAt)` (if that is in the past use now + 5 minutes); else `capture_now: true`, `start_time: easypayDateTime(addInterval(now, interval))`. Same customer/order shape as `/subscribe`; checkout URL adds `&mode=update`.
  - `POST /api/payment/cancel` (existing): if `subscriptionCancelledAt` already set → 200 with the same body, no Easypay call.

- [ ] **Step 1: Failing tests:** amount happy path (PATCH body `{value: 15}`), amount below yearly floor for a yearly subscription → 400 `INVALID_CONTRIBUTION`, amount for an admin-granted member → 400 `NOT_EASYPAY_MEMBER`; resume happy path (PATCH body has `status`, `frequency`, `start_time`, and `subscriptionCancelledAt: null` written), resume when not cancelled → `NOT_CANCELLED`, resume after expiry+grace → `ACCESS_ENDED`; update-method while active → Easypay checkout body has `capture_now: false` and `start_time` equal to the expiry; update-method when lapsed → `capture_now: true`; cancel twice → second call makes no fetch.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** all + typecheck — green.
- [ ] **Step 5: Commit** `feat(payments): let members change amount, resume and replace their card`.

---

### Task 6: Membership emails

**Files:**
- Create: `src/services/membership-emails.ts`
- Modify: `src/routes/payment.ts` (webhook `activated` branch, `payment_failed` branch, cancel handler)
- Test: `tests/services/membership-emails.test.ts`, extend `tests/routes/payment-webhook.test.ts` and `tests/routes/payment-manage.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type Lang = "en" | "pt";
  export function buildWelcomeEmail(p: { lang: Lang; firstName: string | null; amount: number; interval: "month" | "year"; nextPaymentAt: Date; manageUrl: string; retreatsUrl: string }): { subject: string; html: string };
  export function buildPaymentFailedEmail(p: { lang: Lang; firstName: string | null; graceUntil: Date; updateUrl: string }): { subject: string; html: string };
  export function buildCancelledEmail(p: { lang: Lang; firstName: string | null; accessUntil: Date; resumeUrl: string }): { subject: string; html: string };
  export function emailLanguage(preferredLanguage: string | null | undefined): Lang; // "pt" → "pt", else "en"
  ```
  URLs: `manageUrl = updateUrl = resumeUrl = ${config.urls.frontend}/membership`, `retreatsUrl = ${config.urls.frontend}/`. Dates formatted `Intl.DateTimeFormat(lang === "pt" ? "pt-PT" : "en-GB", { day: "numeric", month: "long", year: "numeric" })`. HTML follows `buildMagicLinkEmail` styling (burgundy `#9b1b1b` button). Escape `firstName` (`&<>"'`). Copy (EN; PT equivalent with adesão/contribuição vocabulary):
  - Welcome — subject "Welcome to Padmakara" / "Bem-vindo à Padmakara"; body: thanks, "Your contribution of €{amount} per {month|year} renews automatically on {date}. You can change or cancel it at any time from your membership page." + buttons "Go to my retreats", "Manage my membership".
  - Payment failed — subject "We couldn't take your Padmakara contribution" / "Não foi possível processar a sua contribuição Padmakara"; body: "Your access continues until {graceUntil}. Update your payment method to keep it." + button.
  - Cancelled — subject "Your Padmakara membership ends on {date}" / "A sua adesão à Padmakara termina a {date}"; body: no further payments, access until date, button "Resume my membership".
  - No string contains "subscription"/"subscrição"/"assinatura".
- Wiring: webhook `activated` (first activation only, not `extended`) → welcome; `payment_failed` → failed email with `graceUntil = subscriptionExpiresAt + graceDays` (skip if no expiry); successful cancel (not the idempotent repeat) → cancelled email. Sending is fire-and-forget: `sendEmail(...).catch(err => console.error(...))` — a mail failure must never change the HTTP answer to Easypay.

- [ ] **Step 1: Failing tests:** builders (subject per language, amount and date present, escaped name, banned-word scan over all six outputs); webhook tests mock `../../src/services/email.ts` (`vi.mock` with `sendEmail: vi.fn(() => Promise.resolve())`) and assert one call on `activated`, zero on `extended`, one on failed capture; cancel test asserts one call; a test where `sendEmail` rejects still returns 200 from the webhook.
- [ ] **Step 2–4:** run → implement → run all + typecheck.
- [ ] **Step 5: Commit** `feat(payments): email members on joining, failed renewals and cancelling`.

---

### Task 7: Localized, branded checkout page

**Files:**
- Modify: `src/routes/payment.ts` (`GET /checkout/:id`, `EASYPAY_CHECKOUT_SDK` → `https://cdn.easypay.pt/checkout/2.9.1/`)
- Test: `tests/routes/payment.test.ts` (`GET /api/payment/checkout/:id` describe)

**Interfaces:**
- Consumes query params `session` (required), `amount`, `interval`, `lang` (`pt`|`en`, default `en`), `mode` (`update`|absent).
- Produces redirects: success → `${frontend}/membership/confirming?checkout=<id>`; close → `${frontend}/membership/closed`.

Page requirements (screen 4 and 7 of the mockup): `<html lang>` = lang; `<meta name="robots" content="noindex">`; header "PADMAKARA" in EB Garamond (Google Fonts link) burgundy; an order line "Membership, monthly — €10.00 / month" (PT "Adesão mensal — 10,00 € / mês"; yearly variants; `mode=update` shows "Update payment method" / "Atualizar o método de pagamento" instead of the order line); hidden `#declined` banner shown by `onPaymentError`: "Your payment was declined. Nothing was charged. Try another card, or pay by Direct Debit." / "O pagamento foi recusado. Nada foi cobrado. Experimente outro cartão ou pague por Débito Direto."; footer "🔒 Your card details go to Easypay, never to Padmakara." / PT equivalent; fatal `onError` replaces the form with a localized message and a link back to `${frontend}/membership` (no raw error code shown to the member; keep `console.error`). SDK options: `language: lang === "pt" ? "pt_PT" : "en"`, `accentColor: "#9b1b1b"`, `buttonBackgroundColor: "#9b1b1b"`, `inputBorderRadius: 10`, `buttonBorderRadius: 10`, `buttonBoxShadow: false`, `backgroundColor: "#ffffff"`, `hideSubscriptionSummary: false`. All interpolated values go through `JSON.stringify` (script) or an HTML-escape helper (markup); `amount` must parse as a finite number or the order line is omitted. Mobile-first layout, max-width 480px.

- [ ] **Step 1: Failing tests:** `lang=pt` → `<html lang="pt"`, contains `"pt_PT"`, contains "Adesão mensal"; default → `"en"` language and "Membership, monthly"; success URL contains `/membership/confirming?checkout=test-id`; close URL contains `/membership/closed`; `amount=<script>` → response does not contain `<script>alert` and omits the order line; contains `2.9.1`; contains `noindex`; banned-word scan of the HTML body for `subscription`/`subscrição` (case-insensitive) except inside the Easypay SDK URL — assert on the page text you control.
- [ ] **Step 2–4:** run → implement → run all + typecheck.
- [ ] **Step 5: Commit** `feat(payments): localize and brand the Easypay checkout page`.

---

## App (worktree `padmakara-app-membership`)

Before Task 8: `sh -c 'cd /Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-app-membership && npm install'`, then record the baseline `npx tsc --noEmit 2>&1 | grep -c "error TS"` and `npx jest 2>&1 | tail -5`.

### Task 8: API layer, membership service, server-computed access

**Files:**
- Modify: `services/apiConfig.ts` (`ApiResponse`, endpoints), `services/apiService.ts` (~line 284 error branch), `types/index.ts` (User.subscription), `contexts/AuthContext.tsx` (~line 453 `hasActiveSubscription`)
- Create: `services/membershipService.ts`, `utils/membership.ts`
- Test: `__tests__/services/membershipService.test.ts`, `__tests__/utils/membership.test.ts`

**Interfaces:**
- `ApiResponse<T>` gains `status?: number; code?: string;` — the `!response.ok` branch returns `{ success: false, error, status: response.status, code: typeof data === 'object' ? data.code : undefined }`.
- `API_ENDPOINTS` adds: `MEMBERSHIP: '/payment/membership'`, `MEMBERSHIP_JOIN: '/payment/subscribe'`, `MEMBERSHIP_CANCEL: '/payment/cancel'`, `MEMBERSHIP_RESUME: '/payment/resume'`, `MEMBERSHIP_AMOUNT: '/payment/amount'`, `MEMBERSHIP_UPDATE_METHOD: '/payment/update-method'`, `MEMBERSHIP_CHECKOUT_STATUS: (id: string) => \`/payment/checkout-status/${encodeURIComponent(id)}\``, `EVENT_PREVIEW: (id: string) => \`/events/${id}/preview\``. Remove `PAYMENT_SUBSCRIBE`/`PAYMENT_CANCEL` once Task 12 removes their last users.
- `User.subscription` becomes `{ status; source; expiresAt; cancelledAt?: string | null; amount?: number | null; hasAccess?: boolean }`. `AuthContext.hasActiveSubscription` = `user.subscription.hasAccess` when it is a boolean, else the old derivation (older cached user objects).
- `utils/membership.ts` (mirrors API D2):
  ```ts
  export type MembershipInterval = 'month' | 'year';
  export const MIN_AMOUNT: Record<MembershipInterval, number> = { month: 5, year: 60 };
  export const MAX_AMOUNT = 1000;
  export const SUGGESTED: Record<MembershipInterval, number[]> = { month: [5, 10, 20], year: [60, 120, 240] };
  export function validateAmount(raw: string | number, interval: MembershipInterval): { ok: true; amount: number } | { ok: false; reason: 'nan' | 'min' | 'max' | 'decimals' };
  export function formatEuro(amount: number, language: 'en' | 'pt'): string; // en "€10" / "€12.50", pt "10 €" / "12,50 €"
  ```
- `services/membershipService.ts`:
  ```ts
  export interface MembershipView { /* exactly the API MembershipView from Task 4 */ }
  export type CheckoutState = 'active' | 'processing' | 'failed' | 'pending';
  export const membershipService: {
    get(): Promise<ApiResponse<MembershipView>>;
    join(amount: number, interval: MembershipInterval, language: 'en' | 'pt'): Promise<ApiResponse<{ url: string }>>;
    cancel(): Promise<ApiResponse<{ url: string; accessUntil: string | null }>>;
    resume(): Promise<ApiResponse<{ accessUntil: string }>>;
    changeAmount(amount: number): Promise<ApiResponse<{ amount: number }>>;
    updateMethod(language: 'en' | 'pt'): Promise<ApiResponse<{ url: string }>>;
    checkoutStatus(checkoutId: string): Promise<ApiResponse<{ state: CheckoutState; method: 'card' | 'direct_debit' | null }>>;
  };
  ```

- [ ] **Step 1: Failing tests** for `validateAmount` (5 ok, 4.99 min, 60 year ok, 59 year min, 1000.01 max, '12,50' accepted as 12.5, '12.555' decimals, 'abc' nan) and `formatEuro`; for `membershipService` mock `apiService` (`jest.mock('../../services/apiService')`) and assert endpoint + body for `join` (`{ amount, interval, language }`) and `changeAmount`.
- [ ] **Step 2–4:** run (`npx jest __tests__/utils/membership.test.ts __tests__/services/membershipService.test.ts`) → implement → run + `npx tsc --noEmit` error count unchanged.
- [ ] **Step 5: Commit** `feat(membership): add the membership client and server-computed access`.

---

### Task 9: Membership routes and the join screen (screens 3, 14)

**Files:**
- Create: `app/membership/_layout.tsx` (Stack, `headerShown: false`), `app/membership/index.tsx`, `components/membership/JoinMembership.tsx`, `components/membership/ReaderAccountStatus.tsx`, `components/membership/theme.ts`
- Modify: `locales/en.json`, `locales/pt.json` (new `membership` namespace — all keys used in Tasks 9–12)
- Test: `__tests__/components/JoinMembership.test.tsx`, `__tests__/components/ReaderAccountStatus.test.tsx`

**Interfaces:**
- `components/membership/theme.ts` exports `membershipColors` (from `constants/colors.ts`: burgundy 500/600/50, cream, gray scale, green `#15803d` + `#f0fdf4`, amber `#b45309` + `#fffbeb`, red `#b91c1c` + `#fef2f2`) and `fonts = { display: 'EBGaramond_600SemiBold' }`.
- `app/membership/index.tsx`: if `Platform.OS !== 'web'` → `<ReaderAccountStatus />`. Web: not authenticated → join screen whose button routes to `/(auth)/magic-link` with `returnTo: '/membership'`; authenticated → fetch `membershipService.get()`: state `none`/`lapsed` → `<JoinMembership />`, otherwise `<ManageMembership />` (Task 11; until Task 11 lands render a placeholder `Text` — Task 11 replaces it).
- `JoinMembership` props: `{ initialInterval?: MembershipInterval; onJoined?: (url: string) => void }`. Layout = mockup screen 3: title "Become a member", Monthly/Yearly segmented control, chips for `SUGGESTED[interval]` + "Other" (shows a decimal input with "per month · minimum €5" / yearly variant), the support sentence (André's text: "Your contribution keeps the teachings available. It funds recording and archiving, and also translation, transcription and the retreats themselves."), a summary line ("€10 every month" + "Renews automatically. Cancel anytime from your account." / yearly: "€120 every year" + "Paid once a year. Cancel anytime from your account."), primary button "Continue to payment" (disabled + inline reason while `validateAmount` fails), fine print with a link to `/membership/terms`. Default selection €10 monthly. On press: `membershipService.join(amount, interval, language)` → `window.location.href = url`; on error show the API `error` inline under the button (`code === 'INVALID_CONTRIBUTION'` → the localized min/max message).
- `ReaderAccountStatus` = mockup screen 14 / D12: shows "Full access" or "Public content only" from `hasActiveSubscription`, plus name/email; **no price, no button, no URL**. Signed out → "Sign in" button to `/(auth)/magic-link`.

- [ ] **Step 1: Failing tests** (`@testing-library/react-native`, mock `useLanguage` to return `t: (k) => undefined, language: 'en'`, mock `membershipService`): default renders "€10 every month"; pressing Yearly shows €60/€120/€240 chips and "every year"; typing 4 in Other disables the button and shows the minimum message; pressing Continue calls `membershipService.join(10, 'month', 'en')`; `ReaderAccountStatus` rendered with `Platform.OS = 'ios'` contains no "€" and no "padmakara.pt". Add `__tests__/locales/membershipVocabulary.test.ts`: every string under `membership` in both locale files must not match `/subscri|assinatura/i`.
- [ ] **Step 2–4:** run → implement → run + tsc unchanged + `npx jest locales` parity green.
- [ ] **Step 5: Commit** `feat(membership): add the membership route and contribution picker`.

---

### Task 10: Outcome screens — confirming, welcome, processing, declined, closed (screens 5–9)

**Files:**
- Create: `app/membership/confirming.tsx`, `app/membership/closed.tsx`, `components/membership/useCheckoutStatus.ts`
- Modify: `locales/en.json`, `locales/pt.json`
- Test: `__tests__/components/useCheckoutStatus.test.ts`

**Interfaces:**
- `useCheckoutStatus(checkoutId: string | undefined, opts?: { intervalMs?: number; timeoutMs?: number }): { phase: 'checking' | 'active' | 'processing' | 'failed' | 'timeout' | 'missing'; method: 'card' | 'direct_debit' | null }` — defaults 3000 ms / 180000 ms; `missing` immediately when no id; stops on unmount and on any terminal phase; on `active` calls `refreshUserData()` from `useAuth` once.
- `confirming.tsx` reads `checkout` via `useLocalSearchParams`; renders per phase: `checking` → spinner "Confirming your payment…" + "This usually takes a few seconds. You can keep this page open."; `active` → welcome (screen 6: "Welcome to Padmakara", ticks, "Go to my retreats" → `/(tabs)`); `processing` → screen 8 ("Your bank is processing the payment…"); `failed` → screen 7 adapted: "Your payment was declined. Nothing was charged." + "Try again" → `/membership`; `timeout` → "Still confirming. We'll email you as soon as it's done." + "See my membership" → `/membership`; `missing` → redirect to `/membership`. Native: redirect to `/(tabs)` (money screens are web-only).
- `closed.tsx` = screen 9 ("No payment was made", "Try again" → `/membership`, "Not now" → `/(tabs)`).

- [ ] **Step 1: Failing tests** with jest fake timers and a mocked `membershipService.checkoutStatus`: `pending` then `active` → phase `active` and `refreshUserData` called once; dd `processing` → `processing` and polling stops; never resolves → `timeout` after 180 s and no further calls; unmount stops calls; `undefined` id → `missing` with zero calls.
- [ ] **Step 2–4:** run → implement → run + tsc unchanged.
- [ ] **Step 5: Commit** `feat(membership): show truthful payment outcomes`.

---

### Task 11: Manage membership (screens 10–13) and terms page

**Files:**
- Create: `components/membership/ManageMembership.tsx`, `components/membership/ChangeAmountModal.tsx`, `app/membership/terms.tsx`
- Modify: `app/membership/index.tsx` (render `ManageMembership`), locales
- Test: `__tests__/components/ManageMembership.test.tsx`

**Interfaces:**
- `ManageMembership` props `{ membership: MembershipView; onChanged: () => void }`. Layout per mockup: title "Your membership"; status pill (`active` green "Active"; `cancelled` grey "Ends {date}"; `payment_failed` amber "Payment needed"); key/value list Contribution ("€10 / month"), Next payment (accessUntil, hidden when cancelled), Paid with ("Visa •••• 0000" / "Direct Debit"); actions list: Change amount (opens `ChangeAmountModal`), Update payment method (`membershipService.updateMethod(language)` → `window.location.href`), Cancel membership (opens the existing `components/ConfirmationModal.tsx` with title "Cancel your membership?", message "You keep full access until {date}, the end of the period you already paid for. No further payments will be taken.", buttons "Keep my membership" (cancel style) and "Cancel membership" (destructive) → `membershipService.cancel()` → `onChanged()`). `cancelled` state replaces actions with "Resume membership" (`membershipService.resume()` → `onChanged()`). `payment_failed` shows the amber banner "Your last payment didn't go through. Your access continues until {graceUntil}. Update your payment method to keep it." above a primary "Update payment method". Admin/cash/bank-transfer source: show status + "Contact us to change your membership" with no actions. History list (date · amount · Paid/Failed/Refunded). Dates via the existing `formatLongDate(date, language)` helper used in `settings.tsx` (import from wherever settings imports it).
- `ChangeAmountModal` reuses the chip + Other input of `JoinMembership` (extract the shared `AmountPicker` component from Task 9 into `components/membership/AmountPicker.tsx` and use it in both) for the member's current interval; Save → `membershipService.changeAmount(amount)`; copy "Your new contribution applies from your next payment on {date}."
- `app/membership/terms.tsx`: web page titled "Membership terms" with sections Contribution, Renewal, Cancellation, Refunds, Who we are; text in both languages via locale keys; every place needing association data shows a visible placeholder like `[[Legal name of the association]]`, `[[NIF]]`, `[[Address]]`, `[[Contact email]]`, `[[Refund policy to confirm]]`. Banner at top: "Draft — to be completed by Padmakara before launch."

- [ ] **Step 1: Failing tests:** active view lists the three actions and "Visa •••• 0000"; pressing Cancel opens the modal and confirming calls `cancel` then `onChanged`; cancelled view shows "Resume membership" and no "Cancel membership"; payment_failed shows the banner text with the grace date; admin source shows no actions.
- [ ] **Step 2–4:** run → implement → run + tsc unchanged.
- [ ] **Step 5: Commit** `feat(membership): let members manage their membership`.

---

### Task 12: Entry points — locked retreat, publications, settings, home; remove the old screens

**Files:**
- Modify: `services/retreatService.ts` (`getRetreatDetails`, ~line 827–846), `app/(tabs)/(groups)/retreat/[id].tsx` (error/not-found rendering ~line 1275), `app/(tabs)/(groups)/publications.tsx` (~line 604–612), `app/(tabs)/settings.tsx` (account status section ~line 506–552), `app/(tabs)/(groups)/index.tsx` (home), `app/(tabs)/_layout.tsx` (remove the hidden `subscription` tab)
- Create: `components/membership/LockedRetreat.tsx`, `components/membership/MembershipCard.tsx`
- Delete: `app/(tabs)/subscription.tsx`, `app/subscription/success.tsx`, `app/subscription/cancel.tsx`; replace `app/subscription/_layout.tsx` with `app/subscription/[...rest].tsx` that redirects to `/membership` (old links keep working).
- Modify: locales (remove the `subscription` namespace keys no longer referenced; grep first)
- Test: `__tests__/components/LockedRetreat.test.tsx`, `__tests__/services/retreatService.locked.test.ts`

**Interfaces:**
- `getRetreatDetails` return type gains `locked?: { reason: 'auth' | 'membership' | 'other'; preview: EventPreview | null }`. When the authenticated call fails with `code` in `AUTH_REQUIRED|SUBSCRIPTION_REQUIRED` (or `authRequired`), and the public call also fails, call `EVENT_PREVIEW(id)`; on 200 return `{ success: false, locked: { reason, preview } }`; `GROUP_MEMBERSHIP_REQUIRED|EVENT_ATTENDANCE_REQUIRED|ACCESS_DENIED` → `locked: { reason: 'other', preview: null }`. Never cache a locked result.
- `LockedRetreat` props `{ reason; preview: EventPreview | null }`: hero/title/teacher/dates from preview; lock box per screen 1 on web ("Recordings for members", explanatory line, button "Become a member · from €5/month" → `/membership`, link "Already a member? Sign in" when signed out) and per screen 2 on native ("Available to members", "Once your account has access, these recordings appear here automatically.", "Sign in" only when signed out). `reason: 'other'` → "This retreat is available to its participants." with no button on any platform.
- `retreat/[id].tsx` renders `LockedRetreat` when `response.locked` is set, instead of "Retreat not found".
- Publications banner → web: `/membership`; native: keep sign-in for signed-out users, hide the banner for signed-in non-members.
- Settings account section → web: `MembershipCard` (status line from `user.subscription` + "Manage membership" or "Become a member" → `/membership`); native: `ReaderAccountStatus` content (no price/link). Remove all `subscription.*` keys from settings.
- Home (web, signed in, `!hasActiveSubscription`): `MembershipCard` variant "Become a member" above the main content.

- [ ] **Step 1: Failing tests:** retreatService returns `locked.reason === 'membership'` with preview when the API mock answers 403 `SUBSCRIPTION_REQUIRED` then 403 then preview 200; `'other'` for `GROUP_MEMBERSHIP_REQUIRED` without calling preview; `LockedRetreat` web shows "Become a member", ios shows no "€" and no "Become".
- [ ] **Step 2–4:** run → implement → run + tsc unchanged + `grep -rn "PAYMENT_SUBSCRIBE\|PAYMENT_CANCEL\|subscription\.\(subscribe\|manage\)" app components services` returns nothing.
- [ ] **Step 5: Commit** `feat(membership): lead members to the membership page and retire the old screens`.

---

### Task 13: Web smoke test against the sandbox (controller-run, not a subagent)

Run by the controller after Tasks 1–12 are reviewed and merged. Easypay notifies the **production** URL (`https://api.padmakara.pt/api/payment/webhook`, which still runs sandbox credentials), so the end-to-end check happens on production after deploy, not on a local server. Walk the mockup cases with Easypay test data (card `0000000000000000` / `1111111111111111`, DD IBAN `PT50003500011234567890148` / `PT50000201231234567890154`), cancel, resume, change amount, update card; then deactivate every test subscription and reset the test user. Record results in the final report.
