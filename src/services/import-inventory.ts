import { readFileSync } from "node:fs";
import { join, basename } from "node:path";

export interface InventoryZipEntry {
  name: string;
  uncompressedSize: number;
  compressedSize: number;
  type: string;
}

export interface InventoryFile {
  relativePath: string;
  s3Key: string;
  type: string;
  size: number;
  category: string;
  language?: string | null;
  zipContents?: InventoryZipEntry[] | null;
}

export interface InventoryEvent {
  canonicalCode: string;
  s3Path: string;
  matchStatus: string;
  files: InventoryFile[];
}

export interface Inventory {
  metadata: Record<string, unknown>;
  events: InventoryEvent[];
}

const DEFAULT_INVENTORY_PATH = join(
  import.meta.dirname,
  "../../data/s3-inventory.json",
);

let cached: Inventory | null = null;

/**
 * Load the S3 inventory. The default (production) path is cached in memory
 * after the first read; an explicit path (tests) is never cached.
 */
export function loadInventory(path: string = DEFAULT_INVENTORY_PATH): Inventory {
  if (path === DEFAULT_INVENTORY_PATH && cached) return cached;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Inventory;
  if (path === DEFAULT_INVENTORY_PATH) cached = parsed;
  return parsed;
}

export function findInventoryEvent(
  inventory: Inventory,
  eventCode: string,
): InventoryEvent | undefined {
  return inventory.events.find((e) => e.canonicalCode === eventCode);
}

export interface ImportFileDescriptor {
  sourceS3Key: string;
  zipEntryName: string | null;
  filename: string;
  extension: string;
  sizeBytes: number;
  category: string;
  language: string | null;
}

/**
 * Flatten an inventory event into one descriptor per importable file. ZIP
 * files expand into one descriptor per entry (carrying the ZIP key plus the
 * entry path); loose files yield a single descriptor with `zipEntryName: null`.
 */
export function flattenInventoryEvent(
  event: InventoryEvent,
): ImportFileDescriptor[] {
  const rows: ImportFileDescriptor[] = [];
  for (const file of event.files) {
    if (file.zipContents && file.zipContents.length > 0) {
      for (const entry of file.zipContents) {
        rows.push({
          sourceS3Key: file.s3Key,
          zipEntryName: entry.name,
          filename: basename(entry.name),
          extension: entry.type,
          sizeBytes: entry.uncompressedSize,
          category: file.category,
          language: file.language ?? null,
        });
      }
    } else {
      rows.push({
        sourceS3Key: file.s3Key,
        zipEntryName: null,
        filename: basename(file.s3Key),
        extension: file.type,
        sizeBytes: file.size,
        category: file.category,
        language: file.language ?? null,
      });
    }
  }
  return rows;
}
