-- Payment transaction ledger + subscription bookkeeping columns.
--
-- payment_transactions records every Easypay notification verbatim. It gives us
-- idempotency (dedupe_key), an audit trail, and — because we have never observed a
-- real subscription capture notification — a copy of the first live payload.
--
-- users.subscription_cancelled_at lets "cancelled" and "expired" be different states:
-- a member who cancels keeps access until the period they already paid for runs out.
-- users.subscription_amount records what they actually pay, needed for the scheme-required
-- confirmation email and for measuring churn.

CREATE TABLE IF NOT EXISTS payment_transactions (
  id                  serial PRIMARY KEY,
  user_id             integer REFERENCES users(id) ON DELETE SET NULL,
  notification_id     text NOT NULL,
  notification_type   text,
  notification_status text,
  dedupe_key          text NOT NULL UNIQUE,
  amount              numeric(10, 2),
  currency            text,
  action              text NOT NULL,
  note                text,
  raw_payload         jsonb NOT NULL,
  raw_subscription    jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_transactions_user_id_idx
  ON payment_transactions (user_id);

CREATE INDEX IF NOT EXISTS payment_transactions_notification_id_idx
  ON payment_transactions (notification_id);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_cancelled_at timestamptz;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS subscription_amount numeric(10, 2);
