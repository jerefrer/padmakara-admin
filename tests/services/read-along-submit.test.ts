import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// ---------------------------------------------------------------------------
// submitReadAlongJob — which tracks get aligned against the transcript
// ---------------------------------------------------------------------------

const { mockSelectWhere, mockFindEvent, mockFindTranscript } = vi.hoisted(() => ({
  mockSelectWhere: vi.fn((_where: unknown) => Promise.resolve([{ s3Key: "events/X/001.mp3" }])),
  mockFindEvent: vi.fn(() => Promise.resolve({ id: 920, eventCode: "2019-10-06-KPS" })),
  mockFindTranscript: vi.fn(() => Promise.resolve({ language: "en" })),
}));

vi.mock("@aws-sdk/client-batch", () => ({
  BatchClient: class {
    send() {
      return Promise.resolve({ jobId: "batch-1" });
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
      transcripts: { findFirst: mockFindTranscript },
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
});
