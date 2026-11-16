-- Device fingerprints obtain session tokens, so only their SHA-256 (lower-case
-- hex) is kept at rest. Both columns are `text`, so 64 characters fit.
--
-- The WHERE guard (skip values that are already 64 lower-case hex characters)
-- is what makes this migration re-runnable: without it a second run would hash
-- the hashes and sign every device out. No fingerprint an app build sends is
-- 64 lower-case hex characters (base64 of JSON, `platform-time-random`, short
-- string hashes, `backoffice:` + challenge id, or 43-character base64url), so
-- the guard never skips a raw value.
--
-- device_activations.device_fingerprint is UNIQUE. SHA-256 is injective in
-- practice (no known collision), so distinct fingerprints stay distinct and the
-- constraint holds through the update.
UPDATE "device_activations"
SET "device_fingerprint" = encode(sha256(convert_to("device_fingerprint", 'UTF8')), 'hex')
WHERE "device_fingerprint" !~ '^[0-9a-f]{64}$';--> statement-breakpoint
UPDATE "magic_link_tokens"
SET "device_fingerprint" = encode(sha256(convert_to("device_fingerprint", 'UTF8')), 'hex')
WHERE "device_fingerprint" IS NOT NULL AND "device_fingerprint" !~ '^[0-9a-f]{64}$';
