-- The language an event was actually taught in.
--
-- Tracks already carry `original_language` and `is_translation`, but that is
-- per-file: nothing at the event level says "this is a Tibetan teaching with
-- an English translation". The app needs it to pick which languages to show a
-- user arriving at an event for the first time — the original is always shown,
-- so a Tibetan teaching never renders as though the translator taught it.
--
-- Backfill rule: an event is Tibetan if any of its tracks carries 'tib';
-- otherwise it stays English. That matches how the archive is organised — the
-- Tibetan events are exactly the ones with Tibetan audio.
ALTER TABLE retreats
  ADD COLUMN IF NOT EXISTS original_language text NOT NULL DEFAULT 'en';

UPDATE retreats r
SET original_language = 'tib'
WHERE r.original_language <> 'tib'
  AND EXISTS (
    SELECT 1
    FROM sessions s
    JOIN tracks t ON t.session_id = s.id
    WHERE s.retreat_id = r.id
      AND 'tib' = ANY (t.languages)
  );
