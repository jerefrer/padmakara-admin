/** Identity used to detect a file that was already added: same name and same size. */
export interface FileIdentity {
  name: string;
  size: number;
}

const keyOf = (f: FileIdentity): string => `${f.name}\u0000${f.size}`;

/**
 * Splits dropped files into the ones to upload and the duplicates to skip.
 * A file is a duplicate when `existing` already holds one with the same name
 * and size, or when an earlier file of the same drop has it.
 */
export function splitDuplicateFiles<T extends FileIdentity>(
  dropped: T[],
  existing: FileIdentity[],
): { fresh: T[]; duplicates: T[] } {
  const seen = new Set(existing.map(keyOf));
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const file of dropped) {
    const key = keyOf(file);
    if (seen.has(key)) {
      duplicates.push(file);
    } else {
      seen.add(key);
      fresh.push(file);
    }
  }
  return { fresh, duplicates };
}
