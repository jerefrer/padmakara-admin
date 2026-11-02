import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiskTracker, dirSizeBytes } from "../../containers/video-burn/disk-usage.ts";

describe("DiskTracker", () => {
  it("should report nothing before anything is measured", () => {
    expect(new DiskTracker().snapshot()).toEqual({});
  });

  it("should keep the largest work directory size seen", () => {
    const t = new DiskTracker();
    t.recordWorkDirSize(100);
    t.recordWorkDirSize(900);
    t.recordWorkDirSize(300);
    expect(t.snapshot()).toEqual({ peakWorkDirBytes: 900 });
  });

  it("should report what was measured so far, master included", () => {
    const t = new DiskTracker();
    t.recordMaster(16_300_000_000);
    expect(t.snapshot()).toEqual({ masterBytes: 16_300_000_000 });
    t.recordWorkDirSize(0);
    expect(t.snapshot()).toEqual({ masterBytes: 16_300_000_000, peakWorkDirBytes: 0 });
  });
});

describe("dirSizeBytes", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("should sum files in nested directories", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "disk-usage-test-"));
    await writeFile(path.join(dir, "a.bin"), Buffer.alloc(1000));
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", "b.bin"), Buffer.alloc(234));
    expect(await dirSizeBytes(dir)).toBe(1234);
  });

  it("should return 0 for a missing directory", async () => {
    expect(await dirSizeBytes("/nonexistent-disk-usage-dir")).toBe(0);
  });
});
