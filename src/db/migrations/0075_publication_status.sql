-- Publications gain a Draft / Forthcoming / Published status. The column has
-- existed since 0010 (text, default 'draft') but nothing ever wrote or read it,
-- so every existing row holds the default 'draft' while being live in the app.
-- Mark them published so they stay visible; new publications keep the 'draft'
-- default, as events do.
UPDATE "publications" SET "status" = 'published' WHERE "status" = 'draft';
