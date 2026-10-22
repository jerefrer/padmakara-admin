import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./authFetch", () => ({ authFetch: vi.fn() }));
vi.mock("./videoUploader", () => ({ uploadVideoFile: vi.fn() }));

import { authFetch } from "./authFetch";
import { uploadTracks, type UploadItem, type UploadProgress } from "./uploadManager";

const mockedAuthFetch = vi.mocked(authFetch);

type XhrOutcome = { status: number } | "network-error";

/**
 * Minimal XMLHttpRequest stand-in: each `send` consumes the next scripted
 * outcome (default 200), firing onload or onerror asynchronously.
 */
class FakeXhr {
  static outcomes: XhrOutcome[] = [];
  static sent: string[] = [];
  status = 0;
  statusText = "";
  responseText = "";
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private url = "";
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  abort() {
    this.onabort?.();
  }
  send() {
    FakeXhr.sent.push(this.url);
    const outcome = FakeXhr.outcomes.shift() ?? { status: 200 };
    queueMicrotask(() => {
      if (outcome === "network-error") {
        this.onerror?.();
        return;
      }
      this.status = outcome.status;
      this.onload?.();
    });
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function audioItem(trackId: number, filename: string): UploadItem {
  return {
    trackId,
    sessionNumber: 1,
    file: new File(["abc"], filename, { type: "audio/mpeg" }),
    filename,
    mediaType: "audio",
  };
}

const trackUpdates = () =>
  mockedAuthFetch.mock.calls
    .filter(([url]) => String(url).startsWith("/api/admin/tracks/"))
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) }));

const noDelay = { baseDelayMs: 0, sleep: () => Promise.resolve() };

describe("uploadTracks (audio)", () => {
  const originalXhr = globalThis.XMLHttpRequest;

  beforeEach(() => {
    FakeXhr.outcomes = [];
    FakeXhr.sent = [];
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    mockedAuthFetch.mockReset();
    mockedAuthFetch.mockImplementation(async (url, init) => {
      if (url === "/api/admin/upload/presign") {
        const { files } = JSON.parse(String(init?.body)) as { files: { filename: string }[] };
        return jsonResponse({
          urls: files.map((f) => ({
            filename: f.filename,
            s3Key: `events/E1/${f.filename}`,
            uploadUrl: `https://s3.test/${f.filename}`,
          })),
        });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    globalThis.XMLHttpRequest = originalXhr;
  });

  it("should upload each file and backfill its track's s3_key", async () => {
    const onItemUploaded = vi.fn();

    await uploadTracks([audioItem(1, "001 A.mp3"), audioItem(2, "002 B.mp3")], "E1", () => {}, {
      onItemUploaded,
      retry: noDelay,
    }).promise;

    expect(trackUpdates()).toEqual([
      { url: "/api/admin/tracks/1", body: { s3Key: "events/E1/001 A.mp3", fileSizeBytes: 3 } },
      { url: "/api/admin/tracks/2", body: { s3Key: "events/E1/002 B.mp3", fileSizeBytes: 3 } },
    ]);
    expect(onItemUploaded.mock.calls.map(([item]) => item.trackId)).toEqual([1, 2]);
  });

  it("should retry a file after a dropped connection without failing the upload", async () => {
    FakeXhr.outcomes = ["network-error", { status: 200 }];

    await uploadTracks([audioItem(1, "001 A.mp3")], "E1", () => {}, { retry: noDelay }).promise;

    expect(FakeXhr.sent).toEqual(["https://s3.test/001 A.mp3", "https://s3.test/001 A.mp3"]);
    expect(trackUpdates()).toHaveLength(1);
  });

  it("should presign again before retrying so an expired URL is never reused", async () => {
    FakeXhr.outcomes = [{ status: 503 }, { status: 200 }];

    await uploadTracks([audioItem(1, "001 A.mp3")], "E1", () => {}, { retry: noDelay }).promise;

    const presigns = mockedAuthFetch.mock.calls.filter(([url]) => url === "/api/admin/upload/presign");
    expect(presigns).toHaveLength(2);
  });

  it("should stop at a permanent failure and leave the later tracks untouched", async () => {
    FakeXhr.outcomes = [{ status: 200 }, { status: 403 }];
    const onItemUploaded = vi.fn();
    const reports: UploadProgress[] = [];

    await expect(
      uploadTracks(
        [audioItem(1, "001 A.mp3"), audioItem(2, "002 B.mp3"), audioItem(3, "003 C.mp3")],
        "E1",
        (p) => reports.push(p),
        { onItemUploaded, retry: noDelay },
      ).promise,
    ).rejects.toThrow("S3 upload failed: 403");

    expect(trackUpdates().map((u) => u.url)).toEqual(["/api/admin/tracks/1"]);
    expect(onItemUploaded).toHaveBeenCalledTimes(1);
    expect(reports[reports.length - 1]).toMatchObject({ phase: "error", filesCompleted: 1 });
  });

  it("should retry the track update when the API is briefly unavailable", async () => {
    let trackCalls = 0;
    const presignImpl = mockedAuthFetch.getMockImplementation()!;
    mockedAuthFetch.mockImplementation(async (url, init) => {
      if (String(url).startsWith("/api/admin/tracks/")) {
        trackCalls++;
        return trackCalls === 1 ? jsonResponse({ error: "down" }, 502) : jsonResponse({});
      }
      return presignImpl(url, init);
    });
    const onItemUploaded = vi.fn();

    await uploadTracks([audioItem(1, "001 A.mp3")], "E1", () => {}, {
      onItemUploaded,
      retry: noDelay,
    }).promise;

    expect(trackCalls).toBe(2);
    expect(FakeXhr.sent).toHaveLength(1);
    expect(onItemUploaded).toHaveBeenCalledTimes(1);
  });
});
