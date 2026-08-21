import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// cancelReadAlongJob — terminate via AWS Batch + mark the row terminal
//
// Split into its own file (rather than added to a submitReadAlongJob test
// suite, which doesn't exist yet) to keep the db/AWS mocks minimal — cancel
// only needs readAlongJobs.findFirst + update, not the full event/track
// lookups submitReadAlongJob does.
// ---------------------------------------------------------------------------

const { mockSend, mockUpdateWhere, mockUpdateSet, mockUpdate, mockFindFirstReadAlongJob } =
  vi.hoisted(() => {
    const mockSend = vi.fn((_command?: unknown) => Promise.resolve({}));
    const mockUpdateWhere = vi.fn(() => Promise.resolve());
    const mockUpdateSet = vi.fn((_payload?: Record<string, unknown>) => ({ where: mockUpdateWhere }));
    const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));
    const mockFindFirstReadAlongJob = vi.fn<
      () => Promise<{ id: string; status: string; batchJobId: string | null } | null>
    >(() => Promise.resolve(null));
    return { mockSend, mockUpdateWhere, mockUpdateSet, mockUpdate, mockFindFirstReadAlongJob };
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
  TerminateJobCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  SubmitJobCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    update: mockUpdate,
    query: {
      readAlongJobs: { findFirst: mockFindFirstReadAlongJob },
    },
  },
}));

import { cancelReadAlongJob } from "../../src/services/read-along.ts";

describe("cancelReadAlongJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirstReadAlongJob.mockResolvedValue(null);
    mockSend.mockResolvedValue({});
  });

  it("terminates the Batch job and marks the row failed with a clear reason", async () => {
    mockFindFirstReadAlongJob.mockResolvedValueOnce({
      id: "job-1",
      status: "running",
      batchJobId: "batch-1",
    });

    const result = await cancelReadAlongJob("job-1");

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("Cancelled by an administrator");
    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0] as { input: { jobId: string; reason: string } };
    expect(command.input).toEqual({ jobId: "batch-1", reason: "Cancelled by an administrator" });
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorMessage: "Cancelled by an administrator" }),
    );
  });

  it("rejects cancelling a job that has already finished", async () => {
    mockFindFirstReadAlongJob.mockResolvedValueOnce({
      id: "job-2",
      status: "completed",
      batchJobId: "batch-2",
    });

    await expect(cancelReadAlongJob("job-2")).rejects.toThrow(/already finished/i);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("rejects cancelling a job that does not exist", async () => {
    mockFindFirstReadAlongJob.mockResolvedValueOnce(null);

    await expect(cancelReadAlongJob("nope")).rejects.toThrow(/not found/i);
  });

  it("still marks the row cancelled when AWS Batch reports the job already finished", async () => {
    mockFindFirstReadAlongJob.mockResolvedValueOnce({
      id: "job-3",
      status: "queued",
      batchJobId: "batch-3",
    });
    mockSend.mockRejectedValueOnce(new Error("ClientException: job is not in a terminable state"));

    const result = await cancelReadAlongJob("job-3");

    expect(result.status).toBe("failed");
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorMessage: "Cancelled by an administrator" }),
    );
  });

  it("does not call Batch at all when the job never had a batchJobId", async () => {
    mockFindFirstReadAlongJob.mockResolvedValueOnce({
      id: "job-4",
      status: "pending",
      batchJobId: null,
    });

    const result = await cancelReadAlongJob("job-4");

    expect(mockSend).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
  });
});
