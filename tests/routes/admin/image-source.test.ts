import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testRequest, testJson } from "../../helpers.ts";

// ─── Mocks (must come before route imports) ──────────────────────────────

vi.mock("../../../src/db/index.ts", () => {
  const teacherFindFirst = vi.fn();
  const groupFindFirst = vi.fn();
  return {
    db: {
      query: {
        teachers: { findFirst: teacherFindFirst },
        retreatGroups: { findFirst: groupFindFirst },
      },
      _teacherFindFirst: teacherFindFirst,
      _groupFindFirst: groupFindFirst,
    },
  };
});

vi.mock("../../../src/services/s3.ts", () => ({
  getObjectBytes: vi.fn(),
  // touched by the module's other routes at import time
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  buildTeacherAvatarS3Key: vi.fn(),
  buildTeacherHeroS3Key: vi.fn(),
  buildTeacherHeroMobileS3Key: vi.fn(),
  buildGroupAvatarS3Key: vi.fn(),
  buildGroupHeroS3Key: vi.fn(),
  buildGroupHeroMobileS3Key: vi.fn(),
}));

vi.mock("../../../src/services/image-pipeline.ts", () => ({
  processAvatar: vi.fn(),
  processHero: vi.fn(),
  processHeroMobile: vi.fn(),
}));

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
  bumpUserAccessVersion: vi.fn(() => Promise.resolve()),
}));

// DNS is mocked so no test ever resolves a real name. Each test registers the
// addresses a hostname "resolves" to; an unregistered name fails to resolve.
const dnsTable = new Map<string, string[]>();
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async (hostname: string) => {
    const addresses = dnsTable.get(hostname);
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
  return { lookup, default: { lookup } };
});

import { db } from "../../../src/db/index.ts";
import { getObjectBytes } from "../../../src/services/s3.ts";
import { createAccessToken } from "../../../src/services/auth.ts";

const teacherFindFirst = (db as any)._teacherFindFirst as ReturnType<typeof vi.fn>;
const groupFindFirst = (db as any)._groupFindFirst as ReturnType<typeof vi.fn>;
const mockGetObjectBytes = getObjectBytes as ReturnType<typeof vi.fn>;

const adminToken = () =>
  createAccessToken({ sub: 1, email: "admin@test.com", role: "admin" });
const userToken = () =>
  createAccessToken({ sub: 2, email: "user@test.com", role: "user" });

const auth = async () => ({ Authorization: `Bearer ${await adminToken()}` });

/** The Host a request was meant for: the Host header when the URL was pinned to an IP. */
function requestedHost(input: unknown, init?: RequestInit): string {
  const headers = new Headers(init?.headers);
  return headers.get("host") ?? new URL(String(input)).host;
}

/**
 * A fake origin keyed by "host/path". Honours `redirect: "follow"` the way a
 * real fetch would, so the pre-fix code can be shown to follow a redirect into
 * a private address.
 */
function fakeWeb(routes: Record<string, () => Response>) {
  const calls: { url: string; host: string; init?: RequestInit }[] = [];
  const handle = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const host = requestedHost(input, init);
    calls.push({ url: url.href, host, init });
    const route = routes[`${host}${url.pathname}`];
    const res = route ? route() : new Response("not found", { status: 404 });
    const location = res.headers.get("location");
    if (init?.redirect === "follow" && location && res.status >= 300 && res.status < 400) {
      return handle(new URL(location, url).href, { ...init, headers: undefined });
    }
    return res;
  };
  const fetchMock = vi.fn(handle);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, calls };
}

const jpeg = (bytes: number[] = [9, 9]) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { "Content-Type": "image/jpeg" } });
const secret = () =>
  new Response("AccessKeyId=AKIA-secret", { status: 200, headers: { "Content-Type": "image/jpeg" } });

describe("admin image source endpoints", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    dnsTable.clear();
    dnsTable.set("www.khyentsevision.org", ["93.184.216.34"]);
    dnsTable.set("example.com", ["93.184.216.34"]);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Each SSRF bypass of the old string denylist (src/lib/image-source.ts): the
  // stored photoUrl must never cause a request to a non-public address.
  describe("SSRF guard on the legacy photoUrl fallback", () => {
    const refuses = async (photoUrl: string, routes: Record<string, () => Response> = {}) => {
      teacherFindFirst.mockResolvedValueOnce({ id: 7, avatarS3Key: null, photoUrl });
      const { calls } = fakeWeb(routes);
      const { status, body } = await testJson("/api/admin/teachers/7/avatar/source", {
        headers: await auth(),
      });
      return { status, body, calls };
    };

    it("should refuse when a public host redirects to the metadata endpoint", async () => {
      const { status, body, calls } = await refuses("https://example.com/a.jpg", {
        "example.com/a.jpg": () =>
          new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data/" } }),
        "169.254.169.254/latest/meta-data/": secret,
      });
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_IMAGE_URL");
      expect(calls.map((c) => c.host)).not.toContain("169.254.169.254");
    });

    it("should refuse when a public host redirects to loopback", async () => {
      const { status, calls } = await refuses("https://example.com/a.jpg", {
        "example.com/a.jpg": () =>
          new Response(null, { status: 301, headers: { Location: "http://127.0.0.1:3000/admin" } }),
        "127.0.0.1:3000/admin": secret,
      });
      expect(status).toBe(400);
      expect(calls.map((c) => c.host)).not.toContain("127.0.0.1:3000");
    });

    it("should refuse a DNS name that resolves to a private address", async () => {
      dnsTable.set("internal.attacker.example", ["10.0.0.5"]);
      const { status, body, calls } = await refuses("https://internal.attacker.example/x.jpg", {
        "internal.attacker.example/x.jpg": secret,
      });
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_IMAGE_URL");
      expect(calls).toHaveLength(0);
    });

    it.each([
      ["IPv4-mapped IPv6 metadata", "http://[::ffff:169.254.169.254]/latest/meta-data/"],
      ["IPv6 unique local", "http://[fd00::1]/x.jpg"],
      ["IPv6 loopback", "http://[::1]:3000/x.jpg"],
      ["IPv6 link-local", "http://[fe80::1]/x.jpg"],
      ["NAT64 of a private IPv4", "http://[64:ff9b::a00:1]/x.jpg"],
      ["CGNAT 100.64.0.0/10", "http://100.64.0.1/x.jpg"],
      ["decimal-encoded loopback", "http://2130706433/x.jpg"],
      ["unspecified address", "http://0.0.0.0/x.jpg"],
    ])("should refuse a literal %s address", async (_label, photoUrl) => {
      const { status, body, calls } = await refuses(photoUrl);
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_IMAGE_URL");
      expect(calls).toHaveLength(0);
    });

    it("should abort a response larger than the size limit", async () => {
      // 64 MiB streamed in 1 MiB chunks, with no Content-Length to give it away.
      let pulled = 0;
      const { status, body } = await refuses("https://example.com/huge.jpg", {
        "example.com/huge.jpg": () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                if (pulled++ >= 64) return controller.close();
                controller.enqueue(new Uint8Array(1024 * 1024));
              },
            }),
            { status: 200, headers: { "Content-Type": "image/jpeg" } },
          ),
      });
      expect(status).toBe(502);
      expect(body.code).toBe("IMAGE_SOURCE_UNAVAILABLE");
      // Stopped reading soon after the limit instead of buffering everything.
      expect(pulled).toBeLessThan(40);
    });

    it("should refuse a response that is not an image", async () => {
      const { status, body } = await refuses("https://example.com/page", {
        "example.com/page": () =>
          new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }),
      });
      expect(status).toBe(502);
      expect(body.code).toBe("IMAGE_SOURCE_UNAVAILABLE");
    });

    it("should follow a redirect between public hosts", async () => {
      dnsTable.set("cdn.example.net", ["151.101.1.1"]);
      teacherFindFirst.mockResolvedValueOnce({ id: 7, avatarS3Key: null, photoUrl: "https://example.com/a.jpg" });
      const { calls } = fakeWeb({
        "example.com/a.jpg": () =>
          new Response(null, { status: 302, headers: { Location: "https://cdn.example.net/a.jpg" } }),
        "cdn.example.net/a.jpg": () => jpeg([1, 2, 3]),
      });

      const res = await testRequest("/api/admin/teachers/7/avatar/source", { headers: await auth() });

      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      expect(calls.map((c) => c.host)).toEqual(["example.com", "cdn.example.net"]);
    });
  });

  describe("GET /api/admin/teachers/:id/avatar/source", () => {
    it("streams the stored object when the teacher has an S3 avatar", async () => {
      teacherFindFirst.mockResolvedValueOnce({
        id: 5,
        avatarS3Key: "teachers/avatars/5-123.webp",
        photoUrl: null,
      });
      mockGetObjectBytes.mockResolvedValueOnce({
        body: new Uint8Array([1, 2, 3, 4]),
        contentType: "image/webp",
      });

      const res = await testRequest("/api/admin/teachers/5/avatar/source", {
        headers: await auth(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3, 4]),
      );
      expect(mockGetObjectBytes).toHaveBeenCalledWith("teachers/avatars/5-123.webp");
    });

    // The bug this endpoint exists for: legacy avatars live on third-party
    // hosts that send no CORS headers, so the browser cannot read them.
    it("fetches the legacy external photoUrl server-side when there is no S3 key", async () => {
      teacherFindFirst.mockResolvedValueOnce({
        id: 6,
        avatarS3Key: null,
        photoUrl: "https://www.khyentsevision.org/wp-content/uploads/x.jpg",
      });
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(new Uint8Array([9, 9]), {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          }),
        ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const res = await testRequest("/api/admin/teachers/6/avatar/source", {
        headers: await auth(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
      expect(fetchMock).toHaveBeenCalledOnce();
      // Pinned to the address that was validated, with the real name kept for
      // the Host header and the TLS certificate check.
      const [input, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit & { tls?: { serverName?: string } }];
      expect(String(input)).toBe("https://93.184.216.34/wp-content/uploads/x.jpg");
      expect(new Headers(init.headers).get("host")).toBe("www.khyentsevision.org");
      expect(init.tls?.serverName).toBe("www.khyentsevision.org");
      expect(init.redirect).toBe("manual");
      expect(mockGetObjectBytes).not.toHaveBeenCalled();
    });

    it("returns 502 when the legacy host answers with an error", async () => {
      teacherFindFirst.mockResolvedValueOnce({
        id: 6,
        avatarS3Key: null,
        photoUrl: "https://example.com/gone.jpg",
      });
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response("", { status: 404 })),
      ) as unknown as typeof fetch;

      const { status, body } = await testJson("/api/admin/teachers/6/avatar/source", {
        headers: await auth(),
      });

      expect(status).toBe(502);
      expect(body.code).toBe("IMAGE_SOURCE_UNAVAILABLE");
    });

    it("refuses to fetch a stored URL pointing at a private host", async () => {
      teacherFindFirst.mockResolvedValueOnce({
        id: 7,
        avatarS3Key: null,
        photoUrl: "http://169.254.169.254/latest/meta-data/",
      });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const { status, body } = await testJson("/api/admin/teachers/7/avatar/source", {
        headers: await auth(),
      });

      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_IMAGE_URL");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns 404 when the teacher has no avatar at all", async () => {
      teacherFindFirst.mockResolvedValueOnce({ id: 8, avatarS3Key: null, photoUrl: null });

      const { status } = await testJson("/api/admin/teachers/8/avatar/source", {
        headers: await auth(),
      });

      expect(status).toBe(404);
    });

    it("returns 404 when the teacher does not exist", async () => {
      teacherFindFirst.mockResolvedValueOnce(undefined);

      const { status } = await testJson("/api/admin/teachers/999/avatar/source", {
        headers: await auth(),
      });

      expect(status).toBe(404);
    });

    it("requires authentication", async () => {
      const res = await testRequest("/api/admin/teachers/5/avatar/source");
      expect(res.status).toBe(401);
    });

    it("requires an admin role", async () => {
      const res = await testRequest("/api/admin/teachers/5/avatar/source", {
        headers: { Authorization: `Bearer ${await userToken()}` },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/admin/teachers/:id/hero/source", () => {
    it("streams the stored hero", async () => {
      teacherFindFirst.mockResolvedValueOnce({
        id: 5,
        heroS3Key: "teachers/heroes/5-123.webp",
      });
      mockGetObjectBytes.mockResolvedValueOnce({
        body: new Uint8Array([7]),
        contentType: "image/webp",
      });

      const res = await testRequest("/api/admin/teachers/5/hero/source", {
        headers: await auth(),
      });

      expect(res.status).toBe(200);
      expect(mockGetObjectBytes).toHaveBeenCalledWith("teachers/heroes/5-123.webp");
    });

    it("returns 404 when the teacher has no hero", async () => {
      teacherFindFirst.mockResolvedValueOnce({ id: 5, heroS3Key: null });

      const { status } = await testJson("/api/admin/teachers/5/hero/source", {
        headers: await auth(),
      });

      expect(status).toBe(404);
    });
  });

  describe("group image sources", () => {
    it("streams the stored group avatar", async () => {
      groupFindFirst.mockResolvedValueOnce({
        id: 12,
        avatarS3Key: "groups/avatars/12-123.webp",
        logoUrl: null,
      });
      mockGetObjectBytes.mockResolvedValueOnce({
        body: new Uint8Array([3]),
        contentType: "image/webp",
      });

      const res = await testRequest("/api/admin/groups/12/avatar/source", {
        headers: await auth(),
      });

      expect(res.status).toBe(200);
      expect(mockGetObjectBytes).toHaveBeenCalledWith("groups/avatars/12-123.webp");
    });

    it("falls back to the legacy logoUrl", async () => {
      groupFindFirst.mockResolvedValueOnce({
        id: 12,
        avatarS3Key: null,
        logoUrl: "https://example.com/logo.png",
      });
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(
          new Response(new Uint8Array([4]), {
            status: 200,
            headers: { "Content-Type": "image/png" },
          }),
        ),
      ) as unknown as typeof fetch;

      const res = await testRequest("/api/admin/groups/12/avatar/source", {
        headers: await auth(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    });

    it("streams the stored group hero", async () => {
      groupFindFirst.mockResolvedValueOnce({
        id: 12,
        heroS3Key: "groups/heroes/12-123.webp",
      });
      mockGetObjectBytes.mockResolvedValueOnce({
        body: new Uint8Array([5]),
        contentType: "image/webp",
      });

      const res = await testRequest("/api/admin/groups/12/hero/source", {
        headers: await auth(),
      });

      expect(res.status).toBe(200);
      expect(mockGetObjectBytes).toHaveBeenCalledWith("groups/heroes/12-123.webp");
    });

    it("returns 404 for a missing group", async () => {
      groupFindFirst.mockResolvedValueOnce(undefined);

      const { status } = await testJson("/api/admin/groups/999/avatar/source", {
        headers: await auth(),
      });

      expect(status).toBe(404);
    });
  });
});
