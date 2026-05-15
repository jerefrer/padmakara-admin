import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  language?: string;
  zipContents?: InventoryZipEntry[];
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
