import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.ts", () => ({ db: {} }));
vi.mock("../../src/services/s3.ts", () => ({ getObjectBytes: vi.fn() }));

import { planPageCountBackfill } from "../../src/scripts/backfill-transcript-page-counts.ts";

describe("planPageCountBackfill", () => {
  it("should list only the rows whose stored page count differs from the PDF", async () => {
    const pages: Record<string, number> = { "a.pdf": 12, "b.pdf": 30 };
    const plan = await planPageCountBackfill(
      [
        { id: 1, s3Key: "a.pdf", pageCount: null },
        { id: 2, s3Key: "b.pdf", pageCount: 30 },
      ],
      async (key) => pages[key]!,
    );

    expect(plan.changes).toEqual([{ id: 1, from: null, to: 12 }]);
    expect(plan.unchanged).toBe(1);
  });

  it("should report a PDF it cannot read and carry on", async () => {
    const plan = await planPageCountBackfill(
      [
        { id: 1, s3Key: "broken.pdf", pageCount: 4 },
        { id: 2, s3Key: "ok.pdf", pageCount: 1 },
      ],
      async (key) => {
        if (key === "broken.pdf") throw new Error("pdfinfo failed");
        return 2;
      },
    );

    expect(plan.failures).toEqual([{ id: 1, error: "pdfinfo failed" }]);
    expect(plan.changes).toEqual([{ id: 2, from: 1, to: 2 }]);
  });

  it("should skip a row with no file", async () => {
    const countPages = vi.fn();
    const plan = await planPageCountBackfill([{ id: 1, s3Key: null, pageCount: null }], countPages);

    expect(countPages).not.toHaveBeenCalled();
    expect(plan).toEqual({ changes: [], unchanged: 0, failures: [] });
  });
});
