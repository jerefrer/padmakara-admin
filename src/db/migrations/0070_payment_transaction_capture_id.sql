ALTER TABLE "payment_transactions" ADD COLUMN IF NOT EXISTS "easypay_transaction_id" text;--> statement-breakpoint
-- Re-runnable: a second run finds the constraint (or its index) already there.
DO $$ BEGIN
	ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_easypay_transaction_id_unique" UNIQUE("easypay_transaction_id");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
