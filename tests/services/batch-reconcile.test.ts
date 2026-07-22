import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Mocks (must come before route imports) ──────────────────────────────

const { mockSend, mockUpdateWhere, mockUpdateSet, mockUpdate } = vi.hoisted(() => {
  const mockUpdateWhere = vi.fn(() => Promise.resolve());
  const mockUpdateSet = vi.fn((_payload?: Record<string, unknown>) => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  const mockSend = vi.fn((_command?: unknown) => Promise.resolve({ jobs: [] as unknown[] }));
  return { mockSend, mockUpdateWhere, mockUpdateSet, mockUpdate };
});

vi.mock("@aws-sdk/client-batch", () => ({
  BatchClient: class {
    send(command: unknown) {
      return mockSend(command);
    }
  },
  DescribeJobsCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    update: mockUpdate,
  },
}));

import { reconcileReadAlongRows } from "../../src/services/batch-reconcile.ts";

interface FakeRow {
  id: string;
  status: string;
  batchJobId: string | null;
  submittedAt: Date | null;
}

function row(overrides: Partial<FakeRow> & { id: string }): FakeRow {
  return {
    status: "submitted",
    batchJobId: "batch-job",
    submittedAt: new Date(),
    ...overrides,
  };
}

describe("reconcileJobs (via reconcileReadAlongRows)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ jobs: [] });
  });

  it("marks a submitted row failed when AWS Batch reports FAILED", async () => {
    mockSend.mockResolvedValueOnce({
      jobs: [
        {
          jobId: "batch-1",
          status: "FAILED",
          statusReason: "Essential container in task exited",
          stoppedAt: 5_000,
        },
      ],
    });

    await reconcileReadAlongRows([
      row({ id: "job-1", batchJobId: "batch-1", status: "submitted" }),
    ]);

    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    const payload = mockUpdateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.status).toBe("failed");
    expect(payload.errorMessage).toBe("Essential container in task exited");
    expect(payload.completedAt).toEqual(new Date(5_000));
  });

  it("moves a submitted row to running when AWS Batch reports RUNNING", async () => {
    mockSend.mockResolvedValueOnce({
      jobs: [{ jobId: "batch-2", status: "RUNNING" }],
    });

    await reconcileReadAlongRows([
      row({ id: "job-2", batchJobId: "batch-2", status: "submitted" }),
    ]);

    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    const payload = mockUpdateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.status).toBe("running");
  });

  it("moves a submitted row to queued when AWS Batch reports RUNNABLE", async () => {
    mockSend.mockResolvedValueOnce({
      jobs: [{ jobId: "batch-3", status: "RUNNABLE" }],
    });

    await reconcileReadAlongRows([
      row({ id: "job-3", batchJobId: "batch-3", status: "submitted" }),
    ]);

    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    const payload = mockUpdateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.status).toBe("queued");
  });

  it("marks a row failed when AWS Batch reports SUCCEEDED but the webhook grace period (2min) has elapsed", async () => {
    mockSend.mockResolvedValueOnce({
      jobs: [
        {
          jobId: "batch-4",
          status: "SUCCEEDED",
          stoppedAt: Date.now() - 130_000, // >2min ago
        },
      ],
    });

    await reconcileReadAlongRows([
      row({ id: "job-4", batchJobId: "batch-4", status: "submitted" }),
    ]);

    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    const payload = mockUpdateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.status).toBe("failed");
    expect(payload.errorMessage).toMatch(/completion callback was never received/);
  });

  it("leaves a row unchanged when AWS Batch reports SUCCEEDED within the webhook grace period", async () => {
    mockSend.mockResolvedValueOnce({
      jobs: [
        {
          jobId: "batch-5",
          status: "SUCCEEDED",
          stoppedAt: Date.now() - 1_000, // just now
        },
      ],
    });

    await reconcileReadAlongRows([
      row({ id: "job-5", batchJobId: "batch-5", status: "submitted" }),
    ]);

    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("never describes or updates a row that is already completed/failed", async () => {
    await reconcileReadAlongRows([
      row({ id: "job-6", batchJobId: "batch-6", status: "completed" }),
      row({ id: "job-6b", batchJobId: "batch-6b", status: "failed" }),
    ]);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("marks a row failed as aged-out when its batch job id is absent and it was submitted >15min ago", async () => {
    mockSend.mockResolvedValueOnce({ jobs: [] }); // job id not present in response

    await reconcileReadAlongRows([
      row({
        id: "job-7",
        batchJobId: "batch-7",
        status: "submitted",
        submittedAt: new Date(Date.now() - 16 * 60_000),
      }),
    ]);

    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    const payload = mockUpdateSet.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.status).toBe("failed");
    expect(payload.errorMessage).toMatch(/aged out/);
  });

  it("leaves a row unchanged when its batch job id is absent but it was submitted recently (avoids racing a fresh submission)", async () => {
    mockSend.mockResolvedValueOnce({ jobs: [] });

    await reconcileReadAlongRows([
      row({
        id: "job-8",
        batchJobId: "batch-8",
        status: "submitted",
        submittedAt: new Date(Date.now() - 30_000), // 30s ago
      }),
    ]);

    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("does nothing when there are no non-terminal rows with a batchJobId", async () => {
    await reconcileReadAlongRows([
      row({ id: "job-9", batchJobId: null, status: "submitted" }),
    ]);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("swallows AWS errors and does not throw", async () => {
    mockSend.mockRejectedValueOnce(new Error("ThrottlingException"));

    await expect(
      reconcileReadAlongRows([
        row({ id: "job-10", batchJobId: "batch-10", status: "submitted" }),
      ]),
    ).resolves.toBeUndefined();

    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});
