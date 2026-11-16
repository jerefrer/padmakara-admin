import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: { inserted: [] as any[], conflicts: [] as any[], rows: [] as any[], fail: false },
}));

vi.mock("../../src/db/index.ts", () => ({
  db: {
    insert: vi.fn(() => ({
      values: (v: any) => ({
        onConflictDoUpdate: async (c: any) => {
          if (state.fail) throw new Error("db down");
          state.inserted.push(v);
          state.conflicts.push(c);
        },
      }),
    })),
    select: vi.fn(() => {
      const chain: any = {};
      for (const m of ["from", "orderBy", "limit"]) chain[m] = () => chain;
      chain.then = (resolve: (v: unknown) => void) => resolve(state.rows);
      return chain;
    }),
  },
}));

import { testRequest } from "../helpers.ts";
import { createAccessToken } from "../../src/services/auth.ts";
import { browserFamily, reduceBlocked, reduceSource } from "../../src/services/csp-reports.ts";

const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

function post(body: string, contentType: string, headers: Record<string, string> = {}) {
  return testRequest("/api/csp-report", {
    method: "POST",
    headers: { "Content-Type": contentType, "User-Agent": SAFARI_UA, ...headers },
    body,
  });
}

const legacy = {
  "csp-report": {
    "document-uri": "http://localhost:8081/teachings/3?token=SECRET",
    "effective-directive": "img-src",
    "violated-directive": "img-src",
    "blocked-uri": "https://cdn.example.org/pic.png?X-Amz-Signature=SECRET",
    "source-file": "http://localhost:8081/_expo/app.js?v=SECRET#frag",
    "line-number": 12,
    "column-number": 34,
    disposition: "report",
  },
};

beforeEach(() => {
  state.inserted = [];
  state.conflicts = [];
  state.rows = [];
  state.fail = false;
});

describe("POST /api/csp-report", () => {
  it("should store a legacy application/csp-report violation reduced to origins", async () => {
    const res = await post(JSON.stringify(legacy), "application/csp-report");

    expect(res.status).toBe(204);
    expect(state.inserted).toEqual([
      {
        site: "app",
        directive: "img-src",
        blocked: "https://cdn.example.org",
        source: "http://localhost:8081/_expo/app.js",
        lineNumber: 12,
        columnNumber: 34,
        disposition: "report",
        browser: "Safari 18",
      },
    ]);
  });

  it("should store a Reporting API application/reports+json violation", async () => {
    const body = [
      {
        type: "csp-violation",
        url: "http://localhost:8081/x",
        body: {
          documentURL: "http://localhost:5173/#/events?code=SECRET",
          effectiveDirective: "script-src-elem",
          blockedURL: "inline",
          sourceFile: null,
          disposition: "enforce",
        },
      },
      { type: "deprecation", body: { id: "x" } },
    ];

    const res = await post(JSON.stringify(body), "application/reports+json");

    expect(res.status).toBe(204);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      site: "admin",
      directive: "script-src-elem",
      blocked: "inline",
      source: "",
      lineNumber: null,
      disposition: "enforce",
    });
  });

  it("should answer 204 and store nothing for garbage", async () => {
    const samples = [
      "not json",
      "{}",
      "[]",
      "null",
      '{"csp-report": 5}',
      '[{"type":"csp-violation"}]',
      '{"csp-report":{}}',
    ];
    for (const garbage of samples) {
      const res = await post(garbage, "application/csp-report");
      expect(res.status, garbage).toBe(204);
    }
    expect(state.inserted).toEqual([]);
  });

  it("should refuse a body over 16 KB with 413", async () => {
    const res = await post("x".repeat(17 * 1024), "application/csp-report");

    expect(res.status).toBe(413);
    expect(state.inserted).toEqual([]);
  });

  it("should refuse an oversize body even when no length is declared", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(20 * 1024)));
        controller.close();
      },
    });
    const res = await testRequest("/api/csp-report", {
      method: "POST",
      body: stream,
      // @ts-expect-error duplex is required for stream bodies but missing from RequestInit types
      duplex: "half",
    });

    expect(res.status).toBe(413);
  });

  it("should upsert on the four dedupe columns so a repeat increments the counter", async () => {
    await post(JSON.stringify(legacy), "application/csp-report");

    const conflict = state.conflicts[0];
    expect(conflict.target).toHaveLength(4);
    expect(Object.keys(conflict.set)).toEqual(expect.arrayContaining(["count", "lastSeen"]));
  });

  it("should answer 204 even when storing fails", async () => {
    state.fail = true;
    const res = await post(JSON.stringify(legacy), "application/csp-report");

    expect(res.status).toBe(204);
  });

  it("should accept a cross-origin report", async () => {
    const res = await post(JSON.stringify(legacy), "application/csp-report", {
      Origin: "http://localhost:8081",
    });

    expect(res.status).toBe(204);
  });

  it("should never store a query string or fragment", async () => {
    await post(JSON.stringify(legacy), "application/csp-report");

    const stored = JSON.stringify(state.inserted);
    expect(stored).not.toContain("SECRET");
    expect(stored).not.toContain("?");
    expect(stored).not.toContain("#");
  });
});

describe("reduction helpers", () => {
  it("should reduce blocked URIs to keywords or scheme and host", () => {
    expect(reduceBlocked("data:image/png;base64,AAAA")).toBe("data");
    expect(reduceBlocked("blob:https://app.padmakara.pt/uuid")).toBe("blob");
    expect(reduceBlocked("eval")).toBe("eval");
    expect(reduceBlocked("https://a.r2.cloudflarestorage.com/k?X-Amz-Signature=1")).toBe(
      "https://a.r2.cloudflarestorage.com",
    );
    expect(reduceBlocked("garbage")).toBe("unknown");
    expect(reduceBlocked(null)).toBe("unknown");
  });

  it("should reduce a source file to origin and path", () => {
    expect(reduceSource("https://app.padmakara.pt/a/b.js?x=1#y")).toBe("https://app.padmakara.pt/a/b.js");
    expect(reduceSource("")).toBe("");
  });

  it("should reduce a user agent to a browser family and major version", () => {
    expect(browserFamily(SAFARI_UA)).toBe("Safari 18");
    expect(
      browserFamily(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome 132");
    expect(
      browserFamily("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/132.0.0.0 Safari/537.36 Edg/131.0.0.0"),
    ).toBe("Edge 131");
    expect(browserFamily(undefined)).toBe("unknown");
  });
});

describe("GET /api/admin/csp-reports", () => {
  it("should require authentication", async () => {
    const res = await testRequest("/api/admin/csp-reports");

    expect(res.status).toBe(401);
  });

  it("should refuse a non-admin user", async () => {
    const token = await createAccessToken({ sub: 2, email: "u@test.com", role: "user" });
    const res = await testRequest("/api/admin/csp-reports", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(403);
  });

  it("should list the rows for an admin", async () => {
    state.rows = [{ id: 1, site: "app", directive: "img-src", count: 9 }];
    const token = await createAccessToken({ sub: 1, email: "a@test.com", role: "admin" });
    const res = await testRequest("/api/admin/csp-reports", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reports: state.rows, total: 1 });
  });
});
