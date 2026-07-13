# Decisions

## 2026-05-15 — Anonymous event ZIP downloads

**Chosen:** Anonymous (unauthenticated) ZIP download requests for public events are addressed by an unguessable UUID request id, and the event's public status is re-verified at every status check and download. If the event is no longer public, the download is denied even if the request id is known.
**Alternatives:** Require authentication for all downloads; or rely solely on UUID secrecy with no re-check.
**Why:** Public-event content is already public, so UUID-addressed access is acceptable; re-verification closes the window where a since-restricted event's ZIP stays reachable via a stale request.
**Trade-offs:** A leaked request id exposes a still-public event's ZIP (acceptable — the content is public).
**Revisit if:** anonymous downloads are extended to non-public content.

---

## 2026-07-14 — Video playback security (Bunny Stream)

**Chosen:** Maximum security for video, enforced by three independent layers:

1. **Backend access gate (who may watch).** `GET /api/media/video/:sessionVideoId` runs `checkEventAccess()` (`src/services/access.ts`) before issuing anything. Non-public events require authentication; subscriber / group-member / event-participant audiences require `hasActiveSubscription()` — which checks **both** `subscriptionStatus === "active"` **and** `subscriptionExpiresAt >= now`. A lapsed member gets no new playback token. (Sensitive events must therefore be assigned a subscription-gated audience — NOT `public` — in the admin.)
2. **Media Access Token (MAT).** On success the backend issues a short-lived (~4h) JWT scoped to `userId + sessionVideoId + bunnyVideoId + expiry`. The app appends `?mat=` to every HLS-proxy request; the proxy verifies it and signs Bunny URLs on the fly, 302-redirecting segments (Bunny→user direct, no bandwidth on our server).
3. **Bunny CDN token authentication (protects leaked URLs).** The Bunny pull zone has **Token Authentication ENABLED**. Every CDN URL is signed + time-limited; a leaked/shared URL 403s once it expires and cannot be reused for another video. Signing (`signCdnPath` in `src/services/bunny.ts`) = `base64url(sha256(tokenAuthKey + exactPath + expires))` — **exact-URL only** on this pull zone (directory/`token_path` tokens are rejected; verified empirically 2026-07-14).

**Required Bunny config (pull zone `vz-e1a59eba-cf6`, id 6151330; Stream library "Padmakara App", id 703816):**
- Pull zone → Security → **Token Authentication: ON**. Its `ZoneSecurityKey` MUST equal the API's `BUNNY_STREAM_TOKEN_AUTH_KEY`.
- Library → **Enable direct play: ON**, Block-direct-url: OFF, Embed-view-token: OFF (playback goes through the proxy, not the iframe).
- Bunny webhook URL = `https://api.padmakara.pt/api/webhooks/bunny?secret=<BUNNY_WEBHOOK_SECRET>` (backfills `session_videos.duration_seconds`).
- API env: `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY` (library API key), `BUNNY_STREAM_CDN_HOSTNAME`, `BUNNY_STREAM_TOKEN_AUTH_KEY` (= pull-zone ZoneSecurityKey), `BUNNY_WEBHOOK_SECRET`.
- API `secureHeaders` sets `Cross-Origin-Resource-Policy: cross-origin` so the web app (app.padmakara.pt) can load media from the API (api.padmakara.pt) — access is gated by JWT/MAT, not CORP.

**Alternatives:** CDN token auth OFF (simpler; relies only on the backend gate + unguessable GUIDs) — rejected because content is sensitive and a leaked URL would then be replayable forever.

**Why:** Content is private and subscription-funded; a leaked CDN URL must expire and access must stop the moment a subscription lapses.

**Trade-offs:** More Bunny config to keep in sync. The signing code itself is standard and stable — the two prod outages were caused by (a) the Bunny library being deleted/recreated during a content wipe, which reset the pull-zone security config and keys, and (b) CDN token auth being left OFF afterwards — NOT by fragile code. This doc is the recovery checklist.

**Revisit if:** the Bunny library/pull zone is ever recreated (re-apply the config above), or if stricter enforcement is wanted (shorten the MAT TTL below 4h so a lapsed subscriber's in-flight token expires sooner).

---
