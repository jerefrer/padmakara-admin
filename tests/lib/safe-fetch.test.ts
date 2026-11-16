import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// No test resolves a real name: each registers what a hostname "resolves" to.
const dnsTable = new Map<string, string[]>();
vi.mock("node:dns/promises", () => {
  const lookup = vi.fn(async (hostname: string) => {
    const addresses = dnsTable.get(hostname);
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
  return { lookup, default: { lookup } };
});

import {
  isPublicAddress,
  safeFetch,
  SafeFetchError,
  validatePublicUrl,
} from "../../src/lib/safe-fetch.ts";

type PinnedInit = RequestInit & { tls?: { serverName?: string } };

/** Fake web keyed by "Host/path", where Host is the header the pinned request carried. */
function fakeWeb(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; host: string; init: PinnedInit }[] = [];
  const fetchMock = vi.fn(async (input: unknown, init: PinnedInit) => {
    const url = new URL(String(input));
    const host = new Headers(init.headers).get("host") ?? url.host;
    calls.push({ url: url.href, host, init });
    const route = routes[`${host}${url.pathname}`];
    return route ? route() : new Response("not found", { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, calls };
}

const redirect = (location: string, status = 302) => () =>
  new Response(null, { status, headers: { Location: location } });
const image = (bytes = [1, 2, 3]) => () =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { "Content-Type": "image/png" } });

const opts = { timeoutMs: 1000, maxBytes: 1024 };

async function failure(promise: Promise<unknown>): Promise<SafeFetchError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SafeFetchError) return err;
    throw err;
  }
  throw new Error("expected a SafeFetchError");
}

describe("isPublicAddress", () => {
  it.each([
    "93.184.216.34",
    "8.8.8.8",
    "151.101.1.1",
    "2606:4700::1111",
    "2a00:1450:4003:80e::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808", // NAT64 of 8.8.8.8
    "2002:808:808::1", // 6to4 of 8.8.8.8
  ])("should accept public %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    ["0.0.0.0", "unspecified"],
    ["10.1.2.3", "private"],
    ["100.64.0.1", "CGNAT"],
    ["100.127.255.254", "CGNAT upper end"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "link-local metadata"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.0.0.1", "IETF assignments"],
    ["192.0.2.1", "documentation"],
    ["192.168.1.1", "private"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["::", "IPv6 unspecified"],
    ["::1", "IPv6 loopback"],
    ["fe80::1", "IPv6 link-local"],
    ["fc00::1", "IPv6 ULA"],
    ["fd00::1", "IPv6 ULA"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::ffff:a9fe:a9fe", "IPv4-mapped metadata, hex form"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::127.0.0.1", "IPv4-compatible loopback"],
    ["64:ff9b::a00:1", "NAT64 of 10.0.0.1"],
    ["64:ff9b::a9fe:a9fe", "NAT64 of the metadata address"],
    ["64:ff9b:1::1", "local-use NAT64"],
    ["2002:a00:1::1", "6to4 of 10.0.0.1"],
    ["2001:db8::1", "IPv6 documentation"],
    ["2001::1", "Teredo"],
    ["[::1]", "bracketed loopback"],
    ["not-an-ip", "garbage"],
  ])("should refuse %s (%s)", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe("validatePublicUrl", () => {
  beforeEach(() => {
    dnsTable.clear();
    dnsTable.set("example.com", ["93.184.216.34"]);
  });

  it("should return the address to pin to for a public https URL", async () => {
    const target = await validatePublicUrl("https://example.com/a.png");
    expect(target.address).toBe("93.184.216.34");
    expect(target.family).toBe(4);
  });

  it("should refuse http unless allowed", async () => {
    expect((await failure(validatePublicUrl("http://example.com/a.png"))).reason).toBe("blocked");
    await expect(validatePublicUrl("http://example.com/a.png", { allowHttp: true })).resolves.toBeTruthy();
  });

  it.each(["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/", "not a url"])(
    "should refuse %s",
    async (raw) => {
      expect((await failure(validatePublicUrl(raw, { allowHttp: true }))).reason).toBe("blocked");
    },
  );

  it("should refuse URLs carrying credentials", async () => {
    expect((await failure(validatePublicUrl("https://user:pw@example.com/"))).reason).toBe("blocked");
  });

  it("should refuse a name when any of its addresses is private", async () => {
    dnsTable.set("mixed.example", ["93.184.216.34", "10.0.0.1"]);
    expect((await failure(validatePublicUrl("https://mixed.example/"))).reason).toBe("blocked");
  });

  it("should refuse a name that resolves to an IPv6 ULA", async () => {
    dnsTable.set("v6.example", ["fd12:3456::1"]);
    expect((await failure(validatePublicUrl("https://v6.example/"))).reason).toBe("blocked");
  });

  it("should refuse a name that does not resolve", async () => {
    expect((await failure(validatePublicUrl("https://nowhere.example/"))).reason).toBe("blocked");
  });

  it.each(["https://0x7f.1/", "https://017700000001/", "https://127.1/", "https://[::ffff:7f00:1]/"])(
    "should refuse an obfuscated loopback spelling %s",
    async (raw) => {
      expect((await failure(validatePublicUrl(raw))).reason).toBe("blocked");
    },
  );
});

describe("safeFetch", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    dnsTable.clear();
    dnsTable.set("example.com", ["93.184.216.34"]);
    dnsTable.set("cdn.example.net", ["151.101.1.1"]);
    dnsTable.set("v6.example.org", ["2606:4700::1111"]);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("should pin the request to the validated IP and keep the name for Host and TLS", async () => {
    const { calls } = fakeWeb({ "example.com/a.png": image() });
    const res = await safeFetch("https://example.com/a.png", opts);
    expect(res.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls[0]!.url).toBe("https://93.184.216.34/a.png");
    expect(calls[0]!.init.tls?.serverName).toBe("example.com");
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("should bracket a pinned IPv6 address", async () => {
    const { calls } = fakeWeb({ "v6.example.org/a.png": image() });
    await safeFetch("https://v6.example.org/a.png", opts);
    expect(calls[0]!.url).toBe("https://[2606:4700::1111]/a.png");
  });

  it("should keep a non-default port in the Host header", async () => {
    const { calls } = fakeWeb({ "example.com:8443/a.png": image() });
    await safeFetch("https://example.com:8443/a.png", opts);
    expect(calls[0]!.url).toBe("https://93.184.216.34:8443/a.png");
  });

  it("should follow public redirects, including relative ones", async () => {
    const { calls } = fakeWeb({
      "example.com/a": redirect("/b", 301),
      "example.com/b": redirect("https://cdn.example.net/c", 307),
      "cdn.example.net/c": image([7]),
    });
    const res = await safeFetch("https://example.com/a", opts);
    expect(res.body).toEqual(new Uint8Array([7]));
    expect(res.url.href).toBe("https://cdn.example.net/c");
    expect(calls.map((c) => c.host)).toEqual(["example.com", "example.com", "cdn.example.net"]);
  });

  it.each([
    ["metadata IP", "http://169.254.169.254/latest/meta-data/"],
    ["IPv4-mapped metadata", "http://[::ffff:169.254.169.254]/"],
    ["loopback", "https://127.0.0.1/"],
    ["ULA", "https://[fd00::1]/"],
  ])("should refuse a redirect to %s without requesting it", async (_label, location) => {
    const { calls } = fakeWeb({ "example.com/a": redirect(location) });
    const err = await failure(safeFetch("https://example.com/a", { ...opts, allowHttp: true }));
    expect(err.reason).toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("should refuse a redirect to a name that resolves privately", async () => {
    dnsTable.set("rebind.example", ["192.168.0.10"]);
    const { calls } = fakeWeb({ "example.com/a": redirect("https://rebind.example/") });
    expect((await failure(safeFetch("https://example.com/a", opts))).reason).toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("should refuse an https to http downgrade unless http is allowed", async () => {
    fakeWeb({ "example.com/a": redirect("http://cdn.example.net/c"), "cdn.example.net/c": image() });
    expect((await failure(safeFetch("https://example.com/a", opts))).reason).toBe("blocked");
  });

  it("should give up after the redirect limit", async () => {
    fakeWeb({ "example.com/loop": redirect("/loop") });
    const err = await failure(safeFetch("https://example.com/loop", { ...opts, maxRedirects: 3 }));
    expect(err.reason).toBe("too_many_redirects");
  });

  it("should refuse a declared Content-Length over the limit before reading", async () => {
    fakeWeb({
      "example.com/big": () =>
        new Response("x", { status: 200, headers: { "Content-Length": "999999", "Content-Type": "image/png" } }),
    });
    expect((await failure(safeFetch("https://example.com/big", opts))).reason).toBe("too_large");
  });

  it("should stop reading a streamed body once it crosses the limit", async () => {
    let pulled = 0;
    fakeWeb({
      "example.com/stream": () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              pulled++;
              controller.enqueue(new Uint8Array(512));
            },
          }),
          { status: 200, headers: { "Content-Type": "image/png" } },
        ),
    });
    expect((await failure(safeFetch("https://example.com/stream", opts))).reason).toBe("too_large");
    expect(pulled).toBeLessThan(10);
  });

  it("should check the content type when asked", async () => {
    fakeWeb({ "example.com/page": () => new Response("<html>", { headers: { "Content-Type": "text/html" } }) });
    const err = await failure(
      safeFetch("https://example.com/page", { ...opts, acceptContentType: (t) => t.startsWith("image/") }),
    );
    expect(err.reason).toBe("bad_content_type");
  });

  it("should report an HTTP error status", async () => {
    fakeWeb({});
    const err = await failure(safeFetch("https://example.com/missing", opts));
    expect(err.reason).toBe("http_status");
    expect(err.status).toBe(404);
  });

  it("should time out a host that never answers", async () => {
    globalThis.fetch = vi.fn(
      (_input: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    const err = await failure(safeFetch("https://example.com/slow", { ...opts, timeoutMs: 20 }));
    expect(err.reason).toBe("timeout");
  });
});
