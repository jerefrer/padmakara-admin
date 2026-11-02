/**
 * Disk-use evidence for a burn: the master's size and the peak total size of
 * the work directory, sampled after each heavy step. Reported in the
 * completion webhook so the scratch-disk size can be chosen from numbers.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface DiskMetrics {
  /** Size of the downloaded master file, once known. */
  masterBytes?: number;
  /** Largest total size of the work directory seen at any sample. */
  peakWorkDirBytes?: number;
}

/** Total size in bytes of every regular file under `dir`. Files that vanish mid-walk count as 0. */
export async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else if (entry.isFile()) {
      total += await stat(full).then((s) => s.size, () => 0);
    }
  }
  return total;
}

/** Keeps the maximum of the sizes it is given, plus the master's size. Pure. */
export class DiskTracker {
  private master: number | undefined;
  private peak: number | undefined;

  recordMaster(bytes: number): void {
    this.master = bytes;
  }

  recordWorkDirSize(bytes: number): void {
    if (this.peak === undefined || bytes > this.peak) this.peak = bytes;
  }

  /** What was measured so far; unmeasured fields are omitted. */
  snapshot(): DiskMetrics {
    const out: DiskMetrics = {};
    if (this.master !== undefined) out.masterBytes = this.master;
    if (this.peak !== undefined) out.peakWorkDirBytes = this.peak;
    return out;
  }
}
