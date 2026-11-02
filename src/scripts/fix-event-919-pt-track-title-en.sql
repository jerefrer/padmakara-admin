-- ONE-OFF DATA FIX. Not a migration; do not add it to src/db/migrations.
-- NOT EXECUTED. Review, run the preview, then run the transaction below.
--
-- Problem: the AI assistant set title_en on Portuguese-only translation tracks
-- of event 919, so the admin shows an English title above the Portuguese one.
-- The AI applies its titles with title_en_reviewed = false (the admin had not
-- confirmed the wording), so that flag is the marker of "AI-set, never
-- reviewed". Tracks whose English title was typed or confirmed by hand
-- (title_en_reviewed = true) are left alone.
--
-- Scope: tracks of event 919 that are translations (is_translation) spoken
-- only in Portuguese (languages = {pt}), with a non-empty title_en that is
-- still unreviewed.
--
-- The fix: title -> title_pt (the base title had been overwritten with the
-- English one as well, and the admin re-derives title_en from an English
-- title), title_en -> NULL and title_en_reviewed -> true, on exactly those
-- rows. title_pt and everything else are untouched.
--
-- Usage: psql "$DATABASE_URL" -f src/scripts/fix-event-919-pt-track-title-en.sql
-- Run the PREVIEW first; the UPDATE is wrapped so it can be checked before COMMIT.

-- ---------------------------------------------------------------------------
-- 1. PREVIEW: every Portuguese-only translation track of event 919 with an
--    English title, and whether the fix would clear it.
-- ---------------------------------------------------------------------------
SELECT t.id,
       s.session_number,
       t.track_number,
       t.title,
       t.title_pt,
       t.title_en,
       t.title_en_reviewed,
       (NOT t.title_en_reviewed) AS will_be_cleared
FROM tracks t
JOIN sessions s ON s.id = t.session_id
WHERE s.retreat_id = 919
  AND t.is_translation
  AND t.languages = ARRAY['pt']::text[]
  AND COALESCE(btrim(t.title_en), '') <> ''
ORDER BY s.session_number, t.track_number;

-- ---------------------------------------------------------------------------
-- 2. FIX. Inspect the RETURNING rows, then COMMIT (or ROLLBACK).
-- ---------------------------------------------------------------------------
BEGIN;

UPDATE tracks t
SET title = COALESCE(NULLIF(btrim(t.title_pt), ''), t.title),
    title_en = NULL,
    title_en_reviewed = true,
    updated_at = now()
FROM sessions s
WHERE s.id = t.session_id
  AND s.retreat_id = 919
  AND t.is_translation
  AND t.languages = ARRAY['pt']::text[]
  AND COALESCE(btrim(t.title_en), '') <> ''
  AND t.title_en_reviewed = false
RETURNING t.id, t.title AS new_title, t.title_pt;

-- COMMIT;   -- uncomment after checking the rows above
ROLLBACK;    -- remove this line when committing
