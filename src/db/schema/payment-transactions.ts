import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  numeric,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users.ts";

/**
 * Every notification Easypay sends us, recorded verbatim.
 *
 * Three jobs:
 *  1. **Idempotency.** Easypay retries notifications. `dedupeKey` is unique, so a
 *     replayed notification is rejected by the database rather than double-extending
 *     someone's access.
 *  2. **Audit / accounting.** There is otherwise no local record of who paid what and
 *     when — `users.subscriptionStatus` only holds the current state.
 *  3. **Learning what Easypay actually sends.** `rawPayload` and `rawSubscription` are
 *     stored unparsed. We have never observed a real subscription *capture* notification
 *     (see the field-mapping notes in the webhook handler), so the first live one is
 *     evidence we cannot afford to drop on the floor.
 */
export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: serial("id").primaryKey(),

    /**
     * Resolved from `subscription.customer.key`. Null when we could not attribute the
     * notification — those rows are the ones to go read when something looks wrong.
     */
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),

    /** `id` from the notification body. For subscriptions this is the subscription id. */
    notificationId: text("notification_id").notNull(),
    notificationType: text("notification_type"),
    notificationStatus: text("notification_status"),

    /** `${id}:${type}:${status}:${date}` — unique, this is the idempotency guard. */
    dedupeKey: text("dedupe_key").notNull().unique(),

    /**
     * The Easypay capture this row credited (`transactions[].id` of the subscription),
     * set only on rows that extended a membership. Unique: a capture is credited at most
     * once, whatever notifications, replays or reconcile runs see it. Null on rows written
     * before 2026-11-16, whose captures are recognised from their `rawSubscription`
     * instead (see `src/services/membership-captures.ts`).
     */
    easypayTransactionId: text("easypay_transaction_id").unique(),

    amount: numeric("amount", { precision: 10, scale: 2 }),
    currency: text("currency"),

    /**
     * What we did about it. Credit rows (one per Easypay capture, `easypayTransactionId`
     * set): "activated" | "extended". Notification rows: "credited" (its read of Easypay
     * credited captures) | "no_new_capture" (the body claimed a payment Easypay does not
     * list) | "refund_interval_removed" (a refund of a credited capture: one interval taken
     * off) | "chargeback_closed" (access closed, subscription stopped) | "reversed" (either,
     * before 2026-11-17: access closed) | "reversal_review" (a refund or chargeback we could
     * not tie to a capture we credited: for a human) | "ignored" | "tokenized" | "method_updated"
     * | "create_not_adopted" (a subscription_create Easypay does not report as just created)
     * | "unresolved" (could not attribute to a user) | "unverified" (Easypay answered 404).
     * Rows before 2026-11-16 used "activated" / "extended" on the notification row itself.
     */
    action: text("action").notNull(),
    /** Free-text reason, mainly for the non-happy paths. */
    note: text("note"),

    rawPayload: jsonb("raw_payload").notNull(),
    rawSubscription: jsonb("raw_subscription"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("payment_transactions_user_id_idx").on(t.userId),
    index("payment_transactions_notification_id_idx").on(t.notificationId),
  ],
);

export const paymentTransactionsRelations = relations(paymentTransactions, ({ one }) => ({
  user: one(users, {
    fields: [paymentTransactions.userId],
    references: [users.id],
  }),
}));
