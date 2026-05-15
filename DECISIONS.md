# Decisions

## 2026-05-15 — Anonymous event ZIP downloads

**Chosen:** Anonymous (unauthenticated) ZIP download requests for public events are addressed by an unguessable UUID request id, and the event's public status is re-verified at every status check and download. If the event is no longer public, the download is denied even if the request id is known.
**Alternatives:** Require authentication for all downloads; or rely solely on UUID secrecy with no re-check.
**Why:** Public-event content is already public, so UUID-addressed access is acceptable; re-verification closes the window where a since-restricted event's ZIP stays reachable via a stale request.
**Trade-offs:** A leaked request id exposes a still-public event's ZIP (acceptable — the content is public).
**Revisit if:** anonymous downloads are extended to non-public content.

---
