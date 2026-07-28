-- Anonymous (public) ZIP downloads create a download_requests row with no
-- user_id. The schema already models user_id as nullable, but the column was
-- left NOT NULL in the database (schema drift), so every public download 500'd
-- with a not-null violation. Drop the constraint. Idempotent: a no-op if the
-- column is already nullable.
ALTER TABLE "download_requests" ALTER COLUMN "user_id" DROP NOT NULL;
