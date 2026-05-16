import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  loadInventory,
  findInventoryEvent,
  flattenInventoryEvent,
  type InventoryEvent,
} from "../../src/services/import-inventory.ts";

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
    expect(rows[0]).toEqual({
      sourceS3Key: "mediateca/TEST-LOOSE-EVENT/talk.mp3",
      zipEntryName: null,
      filename: "talk.mp3",
      extension: ".mp3",
      sizeBytes: 1200,
      category: "audio1",
      language: null,
    });
    expect(rows[1]).toEqual({
      sourceS3Key: "mediateca/TEST-LOOSE-EVENT/transcript.pdf",
      zipEntryName: null,
      filename: "transcript.pdf",
      extension: ".pdf",
      sizeBytes: 800,
      category: "transcript",
      language: null,
    });
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

  it("deduplicates a file that appears identically in two ZIPs", () => {
    // An event often ships the same audio in an English-only ZIP and an
    // English+Portuguese ZIP — the English files appear in both.
    const event: InventoryEvent = {
      canonicalCode: "DUP",
      s3Path: "x/",
      matchStatus: "matched",
      files: [
        {
          relativePath: "en.zip",
          s3Key: "x/en.zip",
          type: ".zip",
          size: 100,
          category: "audio1",
          language: "Inglês",
          zipContents: [
            {
              name: "01-talk.mp3",
              uncompressedSize: 3000,
              compressedSize: 2900,
              type: ".mp3",
            },
          ],
        },
        {
          relativePath: "en-pt.zip",
          s3Key: "x/en-pt.zip",
          type: ".zip",
          size: 200,
          category: "audio1",
          language: "Inglês | Português",
          zipContents: [
            {
              name: "01-talk.mp3",
              uncompressedSize: 3000,
              compressedSize: 2900,
              type: ".mp3",
            },
            {
              name: "01-palestra.mp3",
              uncompressedSize: 4000,
              compressedSize: 3900,
              type: ".mp3",
            },
          ],
        },
      ],
    };
    const rows = flattenInventoryEvent(event);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.filename)).toEqual([
      "01-talk.mp3",
      "01-palestra.mp3",
    ]);
    // The first occurrence wins — the English-only ZIP.
    expect(rows[0]?.sourceS3Key).toBe("x/en.zip");
  });

  it("keeps same-named files that differ in byte size", () => {
    const event: InventoryEvent = {
      canonicalCode: "DIFF",
      s3Path: "x/",
      matchStatus: "matched",
      files: [
        {
          relativePath: "a.zip",
          s3Key: "x/a.zip",
          type: ".zip",
          size: 1,
          category: "audio1",
          language: null,
          zipContents: [
            {
              name: "talk.mp3",
              uncompressedSize: 3000,
              compressedSize: 2900,
              type: ".mp3",
            },
          ],
        },
        {
          relativePath: "b.zip",
          s3Key: "x/b.zip",
          type: ".zip",
          size: 1,
          category: "audio1",
          language: null,
          zipContents: [
            {
              name: "talk.mp3",
              uncompressedSize: 9999,
              compressedSize: 9000,
              type: ".mp3",
            },
          ],
        },
      ],
    };
    const rows = flattenInventoryEvent(event);
    expect(rows).toHaveLength(2);
  });
});
