import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { loadInventory, findInventoryEvent, flattenInventoryEvent } from "../../src/services/import-inventory.ts";

const FIXTURE = join(import.meta.dirname, "../fixtures/import/sample-inventory.json");

describe("loadInventory", () => {
  it("loads and parses an inventory file", () => {
    const inv = loadInventory(FIXTURE);
    expect(inv.events).toHaveLength(2);
    expect(inv.metadata.sourceBucket).toBe("padmakara-pt");
  });
});

describe("findInventoryEvent", () => {
  it("returns the event matching the canonical code", () => {
    const inv = loadInventory(FIXTURE);
    const event = findInventoryEvent(inv, "TEST-LOOSE-EVENT");
    expect(event?.files).toHaveLength(2);
  });

  it("returns undefined for an unknown code", () => {
    const inv = loadInventory(FIXTURE);
    expect(findInventoryEvent(inv, "DOES-NOT-EXIST")).toBeUndefined();
  });
});

describe("loadInventory caching", () => {
  it("returns the same cached object for repeated default-path calls", () => {
    expect(loadInventory()).toBe(loadInventory());
  });

  it("does not cache when an explicit path is given", () => {
    expect(loadInventory(FIXTURE)).not.toBe(loadInventory(FIXTURE));
  });
});

describe("flattenInventoryEvent", () => {
  it("expands a ZIP into one descriptor per entry", () => {
    const inv = loadInventory(FIXTURE);
    const event = findInventoryEvent(inv, "TEST-ZIP-EVENT")!;
    const rows = flattenInventoryEvent(event);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      sourceS3Key: "mediateca/TEST-ZIP-EVENT/Audio 1/recordings.zip",
      zipEntryName: "TEST/01-JKR.mp3",
      filename: "01-JKR.mp3",
      extension: ".mp3",
      sizeBytes: 3000,
      category: "audio1",
      language: "Inglês | Português",
    });
  });

  it("keeps loose files as single descriptors with null zipEntryName", () => {
    const inv = loadInventory(FIXTURE);
    const event = findInventoryEvent(inv, "TEST-LOOSE-EVENT")!;
    const rows = flattenInventoryEvent(event);

    expect(rows).toHaveLength(2);
    expect(rows[0].zipEntryName).toBeNull();
    expect(rows[0].filename).toBe("talk.mp3");
    expect(rows[1].filename).toBe("transcript.pdf");
    expect(rows[1].language).toBeNull();
  });

  it("returns an empty array for an event with no files", () => {
    const rows = flattenInventoryEvent({
      canonicalCode: "EMPTY",
      s3Path: "x/",
      matchStatus: "matched",
      files: [],
    });
    expect(rows).toEqual([]);
  });
});
