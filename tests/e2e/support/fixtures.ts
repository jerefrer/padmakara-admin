/**
 * E2E test fixture constants.
 *
 * These are plain exported constants — no runtime side-effects. They form the
 * single source of truth for slugs, codes, and user definitions referenced by
 * both `seed.ts` (which inserts the data) and individual test files (which read
 * the inserted data).
 */

// ─── Audience slugs ───────────────────────────────────────────────────────────

/**
 * Canonical slugs for the six audience types used across the e2e suite.
 * These must match the `slug` column values in the `audiences` table.
 */
export const AUDIENCE_SLUGS = {
  freeAnyone: "free-anyone",
  freeSubscribers: "free-subscribers",
  retreatGroupMembers: "retreat-group-members",
  eventParticipants: "event-participants",
  availableOnRequest: "available-on-request-only",
  receivedInitiation: "received-initiation",
} as const;

// ─── Event codes ──────────────────────────────────────────────────────────────

/**
 * One test event per audience type.
 * Each event's `audienceId` is set to the corresponding audience during seeding.
 */
export const EVENT_CODES = {
  anyone: "E2E-ANYONE",
  subscribers: "E2E-SUBS",
  groupMembers: "E2E-GROUP",
  participants: "E2E-PART",
  onRequest: "E2E-REQ",
  initiation: "E2E-INIT",
} as const;

// ─── Test users ───────────────────────────────────────────────────────────────

/**
 * Six test users covering every access-level scenario exercised by the suite.
 *
 * nosub        — no subscription, no group membership, no attendance
 * subscriber   — active subscription only
 * groupMember  — active subscription + member of TEST_GROUP
 * participant  — active subscription + registered attendance at E2E-PART
 * granted      — no subscription but granted access (attendance at E2E-REQ + E2E-INIT)
 * admin        — admin role
 */
export const TEST_USERS = {
  nosub:       { email: "e2e-nosub@example.com",       role: "user"  as const },
  subscriber:  { email: "e2e-subscriber@example.com",  role: "user"  as const },
  groupMember: { email: "e2e-groupmember@example.com", role: "user"  as const },
  participant: { email: "e2e-participant@example.com", role: "user"  as const },
  granted:     { email: "e2e-granted@example.com",     role: "user"  as const },
  admin:       { email: "e2e-admin@example.com",       role: "admin" as const },
} as const;

// ─── Test retreat group ───────────────────────────────────────────────────────

/** Slug for the single test retreat group created during seeding. */
export const TEST_GROUP_SLUG = "e2e-group-alpha";
