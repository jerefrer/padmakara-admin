import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// ---------------------------------------------------------------------------
// submitReadAlongJob — which tracks get aligned against the transcript
// ---------------------------------------------------------------------------

const { mockSelectWhere, mockFindEvent, mockFindTranscripts, mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn((_command: unknown) => Promise.resolve({ jobId: "batch-1" })),
  mockSelectWhere: vi.fn((_where: unknown) => Promise.resolve([{ s3Key: "events/X/001.mp3" }])),
  mockFindEvent: vi.fn(() =>
    Promise.resolve({ id: 920, eventCode: "2019-10-06-KPS", storagePrefix: "2019-10-06-KPS-OLD" }),
  ),
  mockFindTranscripts: vi.fn(() =>
    Promise.resolve([
      { id: 1, language: "en", s3Key: "events/2019-10-06-KPS-OLD/transcripts/en.pdf", isExcerpt: false },
      { id: 2, language: "pt", s3Key: "events/2019-10-06-KPS-OLD/transcripts/pt.pdf", isExcerpt: false },
    ]),
  ),
}));

vi.mock("@aws-sdk/client-batch", () => ({
  BatchClient: class {
    send(command: unknown) {
      return mockSend(command);
    }
  },
  SubmitJobCommand: class {
    constructor(public input: unknown) {}
  },
  DescribeJobsCommand: class {},
  TerminateJobCommand: class {},
}));

vi.mock("../../src/services/s3.ts", () => ({
  putObject: vi.fn(() => Promise.resolve()),
  storageEnvForContainer: () => [],
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      events: { findFirst: mockFindEvent },
      transcripts: { findMany: mockFindTranscripts },
    },
    select: () => ({ from: () => ({ innerJoin: () => ({ where: mockSelectWhere }) }) }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "job-1" }]) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
}));

import { submitReadAlongJob } from "../../src/services/read-along.ts";

describe("submitReadAlongJob", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should align every track spoken in the transcript's language, translations included", async () => {
    // A Tibetan teaching's transcript is its English translation: the tracks
    // that match it are the English *translation* tracks. Filtering them out
    // aligned the event's other English talks — which are not in the PDF —
    // and left "Read along" greyed on every translated verse (event 920).
    await submitReadAlongJob(920);

    // Safe: submitReadAlongJob selects the tracks exactly once.
    const where = mockSelectWhere.mock.calls[0]![0] as SQL;
    const rendered = new PgDialect().sqlToQuery(where);
    expect(rendered.sql).not.toMatch(/is_translation/);
    expect(rendered.sql).toMatch(/original_language/);
    expect(rendered.params).toContain("en");
  });

  it("should pass the stored storage folder and the exact transcript key, not paths rebuilt from the event code", async () => {
    await submitReadAlongJob(920);

    const env = (mockSend.mock.calls[0]![0] as { input: { containerOverrides: { environment: { name: string; value: string }[] } } })
      .input.containerOverrides.environment;
    const value = (name: string) => env.find((e) => e.name === name)?.value;
    expect(value("EVENT_CODE")).toBe("2019-10-06-KPS");
    expect(value("STORAGE_PREFIX")).toBe("2019-10-06-KPS-OLD");
    expect(value("TRANSCRIPT_S3_KEY")).toBe("events/2019-10-06-KPS-OLD/transcripts/en.pdf");
  });

  it("should omit TRANSCRIPT_S3_KEY when no transcript has a file", async () => {
    mockFindTranscripts.mockResolvedValueOnce([]);
    await submitReadAlongJob(920);

    const env = (mockSend.mock.calls[0]![0] as { input: { containerOverrides: { environment: { name: string }[] } } })
      .input.containerOverrides.environment;
    expect(env.some((e) => e.name === "TRANSCRIPT_S3_KEY")).toBe(false);
  });
});
