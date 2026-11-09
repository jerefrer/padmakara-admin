import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db/index.ts", () => ({ db: {} }));

import { trackOrderProblem } from "../../src/services/track-order.ts";

describe("trackOrderProblem", () => {
  it("should accept an order listing each track of the session once", () => {
    expect(trackOrderProblem([1, 2, 3], [3, 1, 2])).toBeNull();
  });

  it("should refuse a track listed twice", () => {
    expect(trackOrderProblem([1, 2, 3], [1, 1, 2, 3])).toMatch(/twice/);
  });

  it("should refuse a track from another session", () => {
    expect(trackOrderProblem([1, 2, 3], [1, 2, 9])).toMatch(/another session/);
  });

  it("should refuse an order that leaves a track out", () => {
    expect(trackOrderProblem([1, 2, 3], [2, 1])).toMatch(/every track/);
  });
});
