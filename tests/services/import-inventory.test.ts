import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { loadInventory, findInventoryEvent } from "../../src/services/import-inventory.ts";

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
