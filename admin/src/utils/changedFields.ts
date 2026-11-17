/**
 * The fields of `now` that differ from `openedWith`, as an update.
 *
 * Editors and forms save only what was changed in them since they opened.
 * Sending their whole opening copy, or comparing it with the live record,
 * wrote older values back over anything that changed elsewhere meanwhile: an
 * approval of an AI title, another admin's edit (event 928, 2026-11-16).
 *
 * Primitives compare with `===`; arrays and objects by their JSON, so a list
 * rebuilt with the same content is not a change.
 */
export function changedFields<T extends object>(openedWith: T, now: T): Partial<T> {
  const changes: Partial<T> = {};
  for (const key of Object.keys(now) as Array<keyof T>) {
    if (!sameValue(openedWith[key], now[key])) changes[key] = now[key];
  }
  return changes;
}

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || (typeof a === "object" && typeof b === "object" && a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));
