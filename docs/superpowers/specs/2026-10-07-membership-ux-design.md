# Membership payment UX — design

Status: approved by Jérémy on 2026-10-07 ("C'est parfait"). Visual reference:
`2026-10-07-membership-ux-mockup.html` in this folder (published as
https://claude.ai/artifact/Lh1sitvY7J57rDfovdjtkS). Screens are referred to by the number
shown in the mockup (1–14).

## Goal

Replace the draft subscription screens with a complete, familiar membership journey:
locked content → choose a contribution → pay (Easypay) → a truthful result → a membership
page to manage it, plus the emails a recurring-payment merchant must send.

## Vocabulary

- User-facing words are **membership / member / contribution** (PT: **adesão / membro /
  contribuição**). Never "subscription", "subscribe", "subscrição", "subscrever" in any UI
  string. Apple Reader-app rule, and it suits the dāna framing.
- Code identifiers and API routes may keep `subscription` where they already exist
  (`users.subscription_*`, `/api/payment/*`).

## Decisions

| # | Decision |
|---|---|
| D1 | Two intervals: **monthly** (Easypay frequency `1M`) and **yearly** (`1Y`). Both are Easypay *subscriptions* paid by **card or Direct Debit** (`methods: ["cc","dd"]`). |
| D2 | Free amount with a floor: **€5/month**, **€60/year**. Suggested amounts €5/€10/€20 per month, ×12 for yearly. Ceiling **€1000** per payment (typo guard). Two decimals max. No yearly discount (André). |
| D3 | First payment is charged at signup (`capture_now: true`); the recurring cycle starts **one interval later** (`start_time` = now + 1 month or + 1 year). Starting it sooner double-charges (observed 2026-10-07). |
| D4 | **Access opens only when money is captured** (`subscription_capture` + `success`). A Direct Debit mandate alone grants nothing; the member sees the "processing" screen (8). |
| D5 | Access lasts until `subscriptionExpiresAt` + `SUBSCRIPTION_GRACE_DAYS` (7). Each successful capture extends from the later of now and the current expiry by one interval, read from the Easypay subscription's `frequency`. No new DB column for the interval. |
| D6 | **Cancel** = Easypay `PATCH status inactive`, keep access until expiry, set `subscriptionCancelledAt`. **Resume** (before expiry) = `PATCH {status:"active", frequency, start_time: <expiry>}`, clear `subscriptionCancelledAt`. After expiry there is nothing to resume: the member joins again. |
| D7 | **Change amount** = `PATCH {value}` on the Easypay subscription (verified in sandbox: immediate, no charge). Applies from the next payment. Same floor/ceiling as D2. |
| D8 | **Update payment method** = a new checkout for a new subscription with the same amount/interval. If the member still has access: `capture_now: false`, `start_time` = current expiry. If access has lapsed (failed renewal): `capture_now: true`, `start_time` = now + interval. When Easypay sends `subscription_create`/`success` for a subscription whose `customer.key` user already has a *different* `easypaySubscriptionId`, deactivate the old one and store the new id. |
| D9 | MB WAY and Multibanco are **not** offered in this phase (they cannot do subscriptions; a one-off yearly payment needs its own flow and renewal reminders). The checkout simply does not list them. |
| D10 | No yearly renewal reminder email in this phase (needs a scheduler that does not exist). Emails sent: **welcome** (first activation), **payment failed** (failed renewal), **membership cancelled**. Language = `users.preferred_language` (`pt` → Portuguese, else English). |
| D11 | Locked retreat: the event detail endpoint already 401/403s. The 401/403 body gains a specific `code` (`AUTH_REQUIRED`, `SUBSCRIPTION_REQUIRED`, …). A new `GET /api/events/:id/preview` returns non-media fields for **published events whose audience is `free-subscribers`** only, so the app can draw screen 1/2. Group-only and participant-only events stay invisible to outsiders. Event *lists* are not changed. |
| D12 | Web shows prices and join/manage actions. **Native (iOS/Android) never shows a price, a join button, or a link to the website** (screens 2 and 14). Native locked state offers "Sign in" only when signed out, otherwise a neutral sentence. |
| D13 | The Easypay checkout page (served by the API) is localized (`en`/`pt`), branded (burgundy accent, rounded corners), passes `language: "pt_PT"|"en"` to SDK **2.9.1**, shows the order line, and on a retryable payment error shows our own banner "Your payment was declined. Nothing was charged." On success it goes to the app's **confirming** screen; on close to the **closed** screen. |
| D14 | The confirming screen (5) polls `GET /api/payment/checkout-status/:checkoutId` every 3 s for up to 3 minutes (a card capture arrives ~50 s after signup in the sandbox). Outcomes: `active` → welcome (6); `processing` with Direct Debit → (8); `failed` → (7) with retry; still pending at 3 min → "still confirming, we'll email you" with a link to the membership page. |
| D15 | The app decides access from a server-computed `user.subscription.hasAccess` (applies grace), not by re-deriving it. |

## Out of scope (later)

- €15 one-off retreat purchase, €5/€10 tiers, downloads policy (André's open decisions).
- MB WAY / Multibanco yearly one-off, renewal reminder emails, invoicing (accountant question).
- Showing locked events in lists.
- Legal pages: the join screen links to `/membership/terms`; this phase adds the route with a
  clearly-marked draft text and `[[LEGAL ENTITY]]`-style placeholders for the association to fill in.
