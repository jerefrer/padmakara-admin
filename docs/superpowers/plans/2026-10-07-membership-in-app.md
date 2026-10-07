# Membership Inside the App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the membership journey inside the app's frame and visual language, and embed Easypay's payment form in an app screen instead of sending members to a separate page.

**Architecture:** The `app/membership/*` routes move under `app/(tabs)/` as a hidden tab (like `settings`), so the desktop shell (nav, brand panel, player) and the phone tab bar wrap them; URLs stay `/membership/...`. The screens are restyled with the app's existing vocabulary taken from `app/(tabs)/settings.tsx`. A new web-only `/membership/pay` screen mounts Easypay's Checkout SDK inline (`display: "inline"`), fed by a checkout manifest the API now returns. The API's hosted checkout page stays as a fallback but is no longer used by the app.

**Tech Stack:** Expo Router v5 (React Native + web), jest-expo; Hono/Bun API, Vitest; Easypay Checkout SDK 2.9.1 (`https://cdn.easypay.pt/checkout/2.9.1/`, global `easypayCheckout.startCheckout`).

**Spec:** Approved by Jérémy on 2026-10-07 ("Ok pour les deux d'affilée"). Visual reference: `docs/superpowers/specs/2026-10-07-membership-in-app-mockup.html` (published at https://claude.ai/artifact/6aDdY19sFYWCEvmgRWX1tK) — sections 1 (choose contribution), 2 (paying), 3 (membership page), 4 (phone). The earlier design doc `docs/superpowers/specs/2026-10-07-membership-ux-design.md` (D1–D15) still binds for behaviour; this plan changes only placement, styling and the payment step.

## Global Constraints

- API worktree: `/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-api-membership`. App worktree: `/Users/jeremy/Documents/Programming/padmakara-backend-frontend/padmakara-app-membership`. Branch `feature/membership-ux` in both (already merged to `main` and deployed — keep committing on the branch). Never touch `padmakara-api/` or `padmakara-app/`.
- zoxide hijacks `cd`: use `sh -c 'cd <dir> && cmd'` or `git -C`.
- API: tests `bunx --bun vitest run`, typecheck `bun run typecheck` (4 pre-existing errors only). App: tests `npx jest --watchman=false`, typecheck `npx tsc --noEmit` (22 pre-existing errors only). Add no new type errors.
- No behaviour regressions: every existing membership test keeps passing (update imports/paths when files move; do not delete tests to make them pass).
- Vocabulary: never "subscription/subscribe/subscrição/subscrever/assinatura" in any UI string. New strings via `t('membership.<key>') || 'English fallback'`, keys in BOTH `locales/en.json` and `locales/pt.json`.
- Native (Platform.OS !== 'web') never shows a price, a pay button, the payment form, or a link to the website. `/membership/pay` on native redirects to `/(tabs)`.
- Visual vocabulary (read `app/(tabs)/settings.tsx` styles first and reuse them, do not invent new ones): page title in EB Garamond small caps burgundy (the settings title style); section labels uppercase, letter-spaced, grey (settings `sectionTitleOutside`); hairline-separated rows with value on the right and chevron (settings rows); primary button = the settings "Sign In" button (square-ish burgundy, EB Garamond); back control = `components/membership/BackButton.tsx` (already exists). **Remove** the rounded pastel boxes, pill chips and the iOS-style segmented control from membership screens.
- URLs stay exactly: `/membership`, `/membership/confirming`, `/membership/closed`, `/membership/terms`, plus new `/membership/pay`. The legacy `app/subscription/[...rest]` redirect keeps working.
- Commit after each task, Conventional Commits, messages end with exactly:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014fTT7HioX2cCSYhm9BZxWp
  ```
- Do not push, deploy, ssh, or call Easypay. The controller does that.

## Review Focus

1. **Double mount / leaks of the SDK** — navigating to `/membership/pay`, away and back must not mount two forms or leave listeners; `unmount()` on leave (Task 4 test).
2. **Reload on `/membership/pay`** — a browser reload must still show the form (manifest comes from the URL), and a missing/garbled manifest must show a clear message with a way back, not a blank page (Task 4 test).
3. **Native leakage** — `/membership/pay` deep-linked on iOS must redirect, never render the form (Task 4 test with `Platform.OS = 'ios'`).
4. **Shell overlap** — on desktop the moved screens must sit inside the shell's centre column, not under the brand panel or player bar; on phone above the tab bar and mini-player (Task 1 manual check by the controller).
5. **Update-card flow** — after a card update the in-app success must go to `/membership/confirming?checkout=<id>&mode=update` exactly as the hosted page did (Task 4 test).

---

### Task 1: Move the membership routes into the app frame

**Files:**
- Move: `app/membership/{_layout,index,confirming,closed,terms}.tsx` → `app/(tabs)/membership/` (use `git mv`)
- Modify: `app/(tabs)/_layout.tsx` (register `membership` as a hidden `Tabs.Screen`, `href: null`, like the old hidden screens), any imports/tests referencing the old paths
- Modify: `app/(tabs)/settings.tsx` — the account/membership section gains a row "Membership" → `/membership` on web (keep the native reader-safe content unchanged)

**Interfaces:** Produces the same URLs as today. `app/(tabs)/membership/_layout.tsx` stays a `Stack` with `headerShown: false`.

- [ ] Step 1: Write a failing test (or update the existing route tests) asserting the screens import from `app/(tabs)/membership/...` and that `app/(tabs)/_layout.tsx` registers `membership` with `href: null`.
- [ ] Step 2: `git mv` the files; fix relative imports (`../../components/...` depth changes); register the screen; keep `BackButton` behaviour (`router.canGoBack() ? back() : replace('/(tabs)')`).
- [ ] Step 3: Add the settings row (web only) using the existing settings row component/style, label `membership.settingsRow` = EN "Membership" / PT "Adesão", value = status text already used by `MembershipCard`.
- [ ] Step 4: Run all app tests + tsc. Commit `refactor(membership): move the membership screens inside the app frame`.

### Task 2: Restyle the join screen in the app's vocabulary (mockup section 1)

**Files:** `components/membership/JoinMembership.tsx`, `components/membership/AmountPicker.tsx`, `app/(tabs)/membership/index.tsx`, locales, tests.

Layout, top to bottom: BackButton; page title "Become a Member" in the settings title style; André's sentence as an italic EB Garamond quote with a thin burgundy left rule; Monthly / Yearly as two small-caps text tabs with a burgundy underline on the active one (not a segmented control); section label "YOUR CONTRIBUTION"; a hairline list of radio rows: "€5 a month", "€10 a month", "€20 a month" (yearly: "€60 a year", "€120 a year", "€240 a year") and "Another amount" whose row shows an inline numeric input with "€" suffix (keep yesterday's behaviour: empty, muted placeholder = minimum, no error until touched, autofocus when the row is chosen); summary as plain text "**€10 every month.** Renews automatically, cancel anytime from your account." (no pink box); the settings-style primary button "Continue to payment"; fine print with the terms link. Default selection €10 monthly. PT row labels "5 € por mês" / "60 € por ano", "Outro valor".

- [ ] Failing tests first: radio rows render with the interval-specific labels; selecting "Another amount" shows the input with "€" after it; summary text updates; button disabled while invalid; no element uses the old pill/segmented styles (assert by testID absence: remove testIDs `amount-chip-*` / `interval-segment` if they exist and add `amount-row-*` / `interval-tab-*`).
- [ ] Implement, run app tests + tsc, commit `feat(membership): restyle the join screen like the rest of the app`.

### Task 3: Restyle the membership page and outcome screens (mockup section 3)

**Files:** `components/membership/ManageMembership.tsx`, `components/membership/ChangeAmountModal.tsx`, `components/membership/ProcessingNotice.tsx`, `app/(tabs)/membership/confirming.tsx`, `app/(tabs)/membership/closed.tsx`, `app/(tabs)/membership/terms.tsx`, locales, tests.

- Manage page = settings layout: BackButton ("‹ Settings" when coming from settings is not required — plain back is fine); title "Membership"; a status line (green dot "Active member", grey "Ends {date}", amber "Payment needed"); section "YOUR CONTRIBUTION" with rows Contribution (value "€10 a month", chevron → change amount), Next payment (value date, no chevron), Paid with (value "Visa •••• 4242" / "Direct Debit", chevron → update payment method); section "PAYMENTS" with the history rows (date left, "€10.00 · Paid" right); a final separate row "Cancel membership" in burgundy text with chevron (opens the existing confirmation modal); cancelled state replaces it with a primary button "Resume membership"; failed-payment banner becomes a plain amber-text paragraph above the rows (no rounded tinted box). Admin-granted members: status line + "Contact us to change your membership", no rows with chevrons.
- Outcome screens (confirming phases, closed, processing): centred EB Garamond title + body in the app's text style + settings-style buttons; drop the circular tinted icons in favour of a simple Ionicons glyph in burgundy/green like the settings icons.
- Terms page: settings title style, section labels, plain paragraphs.
- [ ] Failing tests first (update existing component tests to the new structure: rows by testID `membership-row-contribution|next-payment|paid-with`, cancel row `membership-row-cancel`), then implement, run tests + tsc, commit `feat(membership): restyle the membership page and outcome screens`.

### Task 4: Embedded payment screen (mockup section 2)

**Files:**
- API: `src/routes/payment.ts` (`/subscribe`, `/update-method`), tests in `tests/routes/payment-webhook.test.ts` / `payment-manage.test.ts`.
- App: Create `app/(tabs)/membership/pay.tsx`, `components/membership/EasypayCheckout.web.tsx`, `components/membership/EasypayCheckout.tsx` (native stub returning null), `services/membershipService.ts` (types), `components/membership/JoinMembership.tsx` + `ManageMembership.tsx` (navigate instead of `window.location`), locales, tests.

**Interfaces:**
- API `/subscribe` and `/update-method` responses become `{ url: string; checkout: { id: string; session: string }; testing: boolean }` (`url` kept unchanged as fallback; `testing = config.easypay.testing`). Mock mode: `checkout: { id: "mock_session", session: "mock" }`, `testing: true`.
- App route: `/membership/pay?id=<checkout id>&session=<session>&amount=<n>&interval=<month|year>&mode=<update?>&testing=<0|1>` (URL-encode session).
- `EasypayCheckout` (web) props: `{ manifest: { id: string; session: string }; testing: boolean; language: 'en' | 'pt'; onSuccess(): void; onClose(): void; onPaymentError(): void; onFatal(): void }`. It loads the SDK script once (inject `<script src="https://cdn.easypay.pt/checkout/2.9.1/">` if `window.easypayCheckout` is absent; resolve on load; reject on error → `onFatal`), renders a `View nativeID="easypay-checkout"`, calls `easypayCheckout.startCheckout(manifest, { id: 'easypay-checkout', display: 'inline', testing, language: language === 'pt' ? 'pt_PT' : 'en', accentColor: '#9b1b1b', buttonBackgroundColor: '#9b1b1b', inputBorderRadius: 2, buttonBorderRadius: 2, buttonBoxShadow: false, backgroundColor: '#ffffff', onSuccess, onClose, onPaymentError, onError: onFatal })`, keeps the returned instance and calls `instance.unmount()` on unmount. Guards against a second `startCheckout` for the same mount.
- `pay.tsx`: web only (native → `router.replace('/(tabs)')`). Missing `id`/`session` → message "This payment link is no longer valid." + button back to `/membership`. Layout per mockup: BackButton labelled "Change amount" (update mode: "Back"); title "Payment"; steps line "1 Contribution › 2 Payment › 3 Confirmation" (update mode: hide); on desktop two columns (order summary left: section "YOUR MEMBERSHIP", order row "Monthly contribution · €10.00", sentence "First payment today, then every month until you cancel." / yearly variants, terms link; form right), on phone stacked; under the form "🔒 Card details go to Easypay, never to Padmakara."; on `onPaymentError` show the declined sentence above the form (reuse `membership.declinedTitle` copy); `onSuccess` → `router.replace('/membership/confirming?checkout=<id>' + (mode==='update' ? '&mode=update' : ''))`; `onClose` → `router.replace(mode==='update' ? '/membership' : '/membership/closed')`; `onFatal` → message with link back.
- `JoinMembership` on success of `membershipService.join(...)` navigates to `/membership/pay` with the params above (no more `window.location.href`). `ManageMembership.updateMethod` does the same with `mode=update`.
- [ ] API failing tests: response carries `checkout.id`, `checkout.session`, `testing`; mock mode values. Implement, run API tests + typecheck, commit `feat(payments): return the checkout manifest so the app can embed the form`.
- [ ] App failing tests: `pay.tsx` renders the form container on web with valid params; missing session → invalid-link message; `Platform.OS = 'ios'` → redirect, no form; `EasypayCheckout` calls `startCheckout` once with the options above (mock `window.easypayCheckout`), calls `unmount` on unmount, and maps `onSuccess` to the confirming URL with and without `mode=update`; `JoinMembership` navigates to `/membership/pay?...` instead of setting `window.location`.
- [ ] Implement, run app tests + tsc, commit `feat(membership): pay inside the app with Easypay's embedded form`.

### Task 5: Sandbox walk-through (controller, after deploy)

Run by the main session after Tasks 1–4 are reviewed and deployed: on production (sandbox credentials), desktop and phone widths, join by card (`0000000000000000`, typed with `pressSequentially`), 3-D Secure (`2222222222222222` → Success), declined (`1111111111111111`), Direct Debit (`PT50003500011234567890148`), close the form, update card; check the shell wraps every screen and back works; then deactivate all test subscriptions and reset the test user.
