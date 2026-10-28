# Passkeys: sign in with Face ID or a fingerprint

Date: 2026-10-28. Covers padmakara-api (server) and padmakara-app (web, iOS, Android).

## Intent

Members sign in once per device, with the emailed link or the 6-digit code. The two moments
where that email is a real obstacle are (1) the link from the iOS app to
`https://app.padmakara.pt/account` (the reader-app External Link Account entitlement opens Safari,
which is not signed in) and (2) a new device. A passkey removes the email at those moments: one
glance with Face ID, or a fingerprint.

The audience is mostly 40+, committed to their practice and willing to make an effort to reach
the teachings, but not technical. The word "passkey" stays out of headlines; the benefit is said in
plain words.

User decisions (Jérémy, 2026-10-28):
- Invite people to create a passkey **right after their first email sign-in on a device**. They do
  it once, forget it, and later it "just works" (notably when the iOS app opens `/account` in Safari).
- Explain the benefit very briefly, in words for people over 40.
- "Make it pretty": the invitation is a designed moment, not a system-looking dialog.

## Goals

- Create a passkey from the app (iOS, Android) and from the website.
- Sign in with a passkey on the website (including autofill suggestion in the email field) and in
  the native app, which activates the device exactly like the link or the code.
- A "Face ID & passkeys" area in Settings → Sign-in & security: list, add, rename-free remove.
- Same device-activation rules as the link and the code.

## Non-goals

- Replacing the email link or code. They stay the universal path and the recovery path.
- Passkeys for the admin panel.
- Making passkeys required, or nagging.
- The QR-code cross-device flow beyond what browsers do by themselves.

## Anti-goals (a failure even if it technically works)

- Anyone locked out because of passkeys: every passkey screen keeps a visible way back to email.
- The invitation shown again and again.
- Technical words in the main text ("WebAuthn", "credential", "authenticator", "relying party").
- Any membership or payment wording in the native app (Apple reader-app rule; never
  subscription/subscribe/subscrição/subscrever/assinatura).

## Experience

### 1. The invitation (after the first email sign-in on this device)

Shown once, as a full screen (mobile) or a centred card (desktop web), after a sign-in by link or
code, on a device that supports passkeys, when this user has not dismissed it on this device.

Copy (EN; PT alongside, European Portuguese):

- Title: "Next time, sign in without an email"
- Body: "Save a key on this phone. When you come back, on the website or on a new iPhone or iPad, a
  glance with Face ID is enough. No more waiting for an email."
- Three short points: "Nothing to remember" · "Only you can use it" · "Works with your other Apple
  devices"
- Primary button: "Yes, set it up". Secondary text button: "Not now".
- Small print: "Your phone keeps it safely. You can remove it any time in Settings."

Wording adapts to the platform: "Face ID" / "Touch ID" / "your fingerprint or face" (Android) /
"your computer's fingerprint, face or PIN" (desktop web); "your other Apple devices" (iOS, macOS
Safari) / "your Google account" (Android, Chrome). Words are chosen by platform only (no biometric
type probing needed beyond what Platform/UA gives); when unsure use the generic "your face or
fingerprint".

Visual: the app's existing language (cream ground, burgundy #9b1b1b accents, EB Garamond title,
the dharma-wheel logo or a simple line illustration of a key/face in a soft circle). Calm,
generous spacing, large touch targets (≥48 pt), body ≥17 pt on mobile.

After success: a short confirmation ("Done. Next time, just use Face ID.") then continue to where
the person was going. On cancel or error: no error drama; "Not now" behaviour, with a quiet line
"You can set it up later in Settings."

"Not now": remembered per device and user; the invitation appears again only after a future email
sign-in on another device (it is per device), never twice on the same device.

### 2. Signing in with a passkey

- Website: the email field opts into browser autofill for passkeys (WebAuthn conditional
  mediation), so Safari/Chrome suggest the saved key under the field. Also an explicit secondary
  button "Sign in with Face ID / a passkey" under the email form (wording per platform).
- Native app: the same explicit button on the sign-in sheet/card and the full-page sign-in.
- Success: the device is activated and the person is signed in, like the link or the code.
- Failure or cancel: stay on the email form, no blocking error; a gentle line if a real error
  occurred.

### 3. Settings → Sign-in & security → "Face ID & passkeys"

- Short explanation (one sentence), the list of saved keys (name, e.g. "iPhone" / "Chrome on
  Windows", created date, last used), "Remove" per key with a confirmation, and "Add a key on this
  device" if supported.

## Technical decisions (my calls)

- Server library: `@simplewebauthn/server` v14; web: `@simplewebauthn/browser` v14; native:
  `react-native-passkey` v3.6 (iOS 15+ / Android via Credential Manager), dev-build only (no Expo
  Go), native code changes need a new store build.
- Relying party ID: `app.padmakara.pt` (not `padmakara.pt`: the apex is a Wix site where we cannot
  serve `.well-known` files). Expected web origin `https://app.padmakara.pt`; in development
  `http://localhost:8081` with RP ID `localhost`. RP ID, name ("Padmakara") and origins come from
  config/env (`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS` comma-separated), with those defaults.
- Native ↔ domain association:
  - iOS: `ios.associatedDomains: ["webcredentials:app.padmakara.pt"]` in `app.config.ts`; serve
    `https://app.padmakara.pt/.well-known/apple-app-site-association` (JSON, no extension) with
    `{"webcredentials":{"apps":["8A879BZ53C.org.padmakara.pt"]}}` (team ID from eas.json; bundle ID
    from app.config.ts — verify the production variant's applicationId).
  - Android: serve `https://app.padmakara.pt/.well-known/assetlinks.json` with
    `delegate_permission/common.get_login_creds` for package `org.padmakara.pt` and the signing
    certificate SHA-256 fingerprints. The EAS upload key fingerprint can be read with
    `eas credentials`; the Play app-signing key fingerprint only exists once the Play Console
    account is validated. Until both are filled in, Android native passkeys will fail gracefully
    (the button hides when creation/sign-in errors as unsupported); web passkeys on Android Chrome
    work regardless. Server must also accept the Android app origin
    `android:apk-key-hash:<base64url sha256>` (env `WEBAUTHN_ANDROID_ORIGINS`).
  - The files live in the app repo under `public/.well-known/` so `expo export` copies them into
    `dist`. Caddy must serve `apple-app-site-association` with `Content-Type: application/json`
    (add a matcher in `deploy/padmakara-api.caddy`).
- Data:
  - `passkey_credentials`: id, user_id (FK, cascade on delete), credential_id (text, base64url,
    unique), public_key (text base64url), counter (bigint), transports (text[] / jsonb), device_type,
    backed_up (bool), name (text, from the user agent / platform at creation), created_at,
    last_used_at.
  - `webauthn_challenges`: id (uuid), challenge (text), user_id (nullable: null for sign-in),
    purpose ('register' | 'login'), expires_at (now + 5 min), used (bool). Single use.
  - Account deletion deletes the user's passkeys (add to `src/services/account-deletion.ts`).
- Endpoints (all under `/api/auth`):
  - `POST /passkeys/register/options` (auth) → registration options (user verification required,
    resident key required, excludeCredentials = the user's existing keys), plus `challengeId`.
  - `POST /passkeys/register/verify` (auth) `{ challengeId, response, name? }` → `{ passkey }`.
  - `POST /passkeys/login/options` (public, `authIpLimiter`) → authentication options with no
    allowCredentials (discoverable), plus `challengeId`.
  - `POST /passkeys/login/verify` (public, `authIpLimiter`) `{ challengeId, response,
    device_fingerprint, device_name, device_type }` → find credential by id, verify, update counter
    and last_used_at, `activateDeviceForUser`, tokens; same success shape as `/review-login`. Every
    failure is the same generic 401. Inactive users are refused.
  - `GET /passkeys` (auth) → the user's keys (id, name, created_at, last_used_at).
  - `DELETE /passkeys/:id` (auth, own keys only).
- App:
  - A `services/passkeyService.ts` with a platform split: web uses `@simplewebauthn/browser`,
    native uses `react-native-passkey`; both talk to the endpoints above and store tokens the same
    way `verifyEmailCode` does.
  - `isPasskeySupported()` per platform (web: `browserSupportsWebAuthn()`; native: the library's
    support check; Android false until assetlinks are configured is acceptable).
  - The invitation is triggered from the success path of the email link/code sign-in (all entry
    points: SignInForm sheet/card, full-page check-email). Dismissal flag in AsyncStorage keyed by
    user id.
- Tests: route tests with the existing db mocking pattern, with `@simplewebauthn/server` verify
  functions mocked; app hook/component tests with RTL. Manual end-to-end on the web locally
  (localhost RP) and on an iOS device build later.
- DECISIONS.md entries in both repos (RP ID choice, invitation timing, library choices).

## Left to the builder

Component structure, exact layout spacing, illustration choice within the visual language, the
naming heuristic for keys, and how the invitation is routed (modal route vs overlay) as long as it
works on web, iPhone, iPad and Android and returns the person to where they were going.

## Deployment notes

API: migration + restart (standing permission). Web: export (standing OK). Caddy: copy the site
file and reload. Native: needs a new EAS build (not done as part of this work); Android native
needs the signing fingerprints.
