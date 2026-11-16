/**
 * `resetOptions` for an edit form whose record is refreshed while the admin
 * may be typing: the image editors save through their own routes and then
 * refresh the page. react-admin resets the form to the refetched record; with
 * this, fields the admin changed keep their unsaved value and every other
 * field (the image ones included) takes the fresh one.
 *
 * Module-level on purpose: react-admin resets the form whenever this object
 * changes identity, so an inline literal would reset it on every render.
 */
export const KEEP_UNSAVED_EDITS = { keepDirtyValues: true } as const;
