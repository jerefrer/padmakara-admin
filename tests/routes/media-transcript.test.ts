import { describe, it, expect, vi, beforeEach } from "vitest";
import { PDFDocument } from "pdf-lib";
import { testRequest, testJson } from "../helpers.ts";

const transcriptFindFirst = vi.fn();
const usersFindFirst = vi.fn();

vi.mock("../../src/db/index.ts", () => ({
  db: {
    query: {
      transcripts: { findFirst: (...a: any[]) => transcriptFindFirst(...a) },
      users: { findFirst: (...a: any[]) => usersFindFirst(...a) },
      userEventAttendance: { findFirst: vi.fn(() => Promise.resolve(null)) },
      userGroupMemberships: { findFirst: vi.fn(() => Promise.resolve(null)) },
    },
    select: vi.fn(),
  },
}));

vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn(() => Promise.resolve("https://s3/transcript.pdf")),
  generatePresignedAttachmentUrl: vi.fn(() => Promise.resolve("https://s3/transcript.pdf?attach")),
  getObjectText: vi.fn(),
}));

import { createAccessToken } from "../../src/services/auth.ts";

// The access service is deliberately NOT mocked: the whole point of these
// tests is that the transcript route defers to the real audience rules
// (free-anyone is open to everyone) instead of gating on auth up front.

const PUBLIC_EVENT = { id: 3, status: "published", audience: { slug: "free-anyone" } };
const SUBSCRIBER_EVENT = { id: 4, status: "published", audience: { slug: "free-subscribers" } };

function transcriptRow(event: unknown) {
  return {
    id: 399,
    eventId: (event as any)?.id ?? null,
    language: "en",
    s3Key: "events/E/transcripts/talk.pdf",
    originalFilename: "talk.pdf",
    updatedAt: new Date("2026-01-01"),
    event,
  };
}

/** Smallest valid PDF pdf-lib will round-trip, used as the S3 source object. */
async function makeSourcePdf(): Promise<Uint8Array<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return new Uint8Array(await doc.save());
}

/** Stand in for the S3 GET the route performs against the presigned URL. */
function stubS3Fetch(bytes: Uint8Array<ArrayBuffer>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(bytes, { status: 200 })),
  );
}

const subscriberToken = () =>
  createAccessToken({ sub: 42, email: "u@test.com", role: "user" });

describe("GET /api/media/transcript/:transcriptId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    usersFindFirst.mockResolvedValue({
      id: 42,
      role: "user",
      email: "u@test.com",
      firstName: "Ann",
      lastName: "Lee",
      subscriptionStatus: "active",
      subscriptionExpiresAt: null,
    });
  });

  it("serves a public event's transcript to an anonymous reader", async () => {
    const source = await makeSourcePdf();
    transcriptFindFirst.mockResolvedValueOnce(transcriptRow(PUBLIC_EVENT));
    stubS3Fetch(source);

    const res = await testRequest("/api/media/transcript/399");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("inline");
  });

  it("leaves a public transcript unwatermarked — anyone can fetch the same bytes anonymously", async () => {
    const source = await makeSourcePdf();
    transcriptFindFirst.mockResolvedValueOnce(transcriptRow(PUBLIC_EVENT));
    stubS3Fetch(source);

    const res = await testRequest("/api/media/transcript/399");
    const body = new Uint8Array(await res.arrayBuffer());

    expect(Array.from(body)).toEqual(Array.from(source));
  });

  it("leaves a public transcript unwatermarked for signed-in readers too", async () => {
    const source = await makeSourcePdf();
    transcriptFindFirst.mockResolvedValueOnce(transcriptRow(PUBLIC_EVENT));
    stubS3Fetch(source);

    const res = await testRequest("/api/media/transcript/399", {
      headers: { Authorization: `Bearer ${await subscriberToken()}` },
    });
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(Array.from(body)).toEqual(Array.from(source));
  });

  it("401s an anonymous reader on a non-public event", async () => {
    transcriptFindFirst.mockResolvedValueOnce(transcriptRow(SUBSCRIBER_EVENT));

    const { status } = await testJson("/api/media/transcript/399");

    expect(status).toBe(401);
  });

  it("watermarks a non-public transcript for the reader who fetched it", async () => {
    const source = await makeSourcePdf();
    transcriptFindFirst.mockResolvedValueOnce(transcriptRow(SUBSCRIBER_EVENT));
    stubS3Fetch(source);

    const res = await testRequest("/api/media/transcript/399", {
      headers: { Authorization: `Bearer ${await subscriberToken()}` },
    });
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(Array.from(body)).not.toEqual(Array.from(source));
  });

  it("401s an anonymous reader when the transcript has no event to gate on", async () => {
    transcriptFindFirst.mockResolvedValueOnce(transcriptRow(null));

    const { status } = await testJson("/api/media/transcript/399");

    expect(status).toBe(401);
  });

  it("404s an unknown transcript", async () => {
    transcriptFindFirst.mockResolvedValueOnce(null);

    const { status } = await testJson("/api/media/transcript/999");

    expect(status).toBe(404);
  });

  it("404s a transcript row with no stored file", async () => {
    transcriptFindFirst.mockResolvedValueOnce({ ...transcriptRow(PUBLIC_EVENT), s3Key: null });

    const { status } = await testJson("/api/media/transcript/399");

    expect(status).toBe(404);
  });
});
