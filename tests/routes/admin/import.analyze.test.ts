import { describe, it, expect, vi, beforeEach } from "vitest";
import { testRequest } from "../../helpers.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

vi.mock("../../../src/services/track-analysis.ts", () => ({
  analyzeFolder: vi.fn(async (_input: unknown, onProgress: (e: unknown) => void) => {
    onProgress({ type: "phase", phase: "scanning" });
    onProgress({ type: "phase", phase: "deterministic_parse", totalFiles: 1, totalSessions: 1 });
    onProgress({ type: "phase", phase: "ai_analysis", totalChunks: 1 });
    onProgress({ type: "chunk_progress", done: 1, total: 1 });
    return {
      aiCoverage: {
        totalTracks: 1,
        tracksAnalyzedByAi: 1,
        tracksFromDeterministicFallback: 0,
        chunks: 1,
        chunksFailed: 0,
      },
      event: {
        titleEn: null,
        titlePt: null,
        startDate: null,
        endDate: null,
        matchedGroupIds: [],
        matchedTeacherIds: [],
        matchedPlaceIds: [],
        folderConventionOk: true,
      },
      sessions: [],
      notes: [],
    };
  }),
}));

vi.mock("../../../src/db/index.ts", () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(async () => ({
          id: 1,
          email: "admin@test.com",
          role: "admin",
          firstName: "A",
          lastName: "B",
        })),
      },
      retreatGroups: { findMany: vi.fn(async () => []) },
      teachers: { findMany: vi.fn(async () => []) },
      places: { findMany: vi.fn(async () => []) },
    },
  },
}));

import { db } from "../../../src/db/index.ts";

async function adminToken() {
  return createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
}

async function readSSE(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      events.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.length > 0) events.push(buffer);
  return events;
}

describe("POST /api/admin/import/analyze", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-install the default admin mock after clearAllMocks resets it
    (db.query.users.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1,
      email: "admin@test.com",
      role: "admin",
      firstName: "A",
      lastName: "B",
    });
    (db.query.retreatGroups.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (db.query.teachers.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (db.query.places.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("returns 401 without auth", async () => {
    const res = await testRequest("/api/admin/import/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folderName: "x", files: [] }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin role", async () => {
    const token = await createAccessToken({ sub: 2, email: "user@test.com", role: "user" });
    const res = await testRequest("/api/admin/import/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ folderName: "x", files: [{ relativePath: "a.mp3", sizeBytes: 1 }] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects payloads missing folderName with 400", async () => {
    const token = await adminToken();
    const res = await testRequest("/api/admin/import/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ files: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("streams the expected SSE event sequence", async () => {
    const token = await adminToken();
    const res = await testRequest("/api/admin/import/analyze", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        folderName: "x",
        files: [{ relativePath: "01_a.mp3", sizeBytes: 1 }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(res.body).not.toBeNull();
    const events = await readSSE(res.body!);
    const eventNames = events
      .map((raw) => /event:\s*(\S+)/.exec(raw)?.[1])
      .filter(Boolean);
    expect(eventNames).toEqual(["phase", "phase", "phase", "chunk_progress", "result"]);
  });
});
