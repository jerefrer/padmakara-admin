import { describe, it, expect, beforeEach, afterEach } from "vitest";
// The fake network below stands in for sockets. That the real Node path only
// connects to addresses the `lookup` hook approved was checked by hand under
// Node 24 (the container runs Node 22): a name resolving to 127.0.0.1 was
// refused with zero hits on a local server. It cannot run here: under Bun, an
// HTTP(S)_PROXY in the environment routes node:http around `lookup`.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { isIP } from "node:net";

import {
  isPublicAddress as containerIsPublic,
  safeDownloadToFile,
  UnsafeUrlError,
  type HopResponse,
  type LookupFunction,
  type Requester,
  type Resolver,
} from "../../containers/video-burn/safe-download.ts";
import { isPublicAddress as apiIsPublic } from "../../src/lib/safe-fetch.ts";

// The container keeps its own copy of the address rules (it cannot import the
// API's src/lib). This pins the two copies together.
describe("container and API address rules", () => {
  const sample = [
    "8.8.8.8", "93.184.216.34", "0.0.0.0", "10.0.0.1", "100.64.0.1", "100.128.0.1", "127.0.0.1",
    "169.254.169.254", "172.15.255.255", "172.16.0.1", "172.32.0.1", "192.0.2.5", "192.168.0.1",
    "198.18.0.1", "198.20.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fc00::1",
    "fd00::1", "ff02::1", "::ffff:169.254.169.254", "::ffff:8.8.8.8", "::127.0.0.1",
    "64:ff9b::a00:1", "64:ff9b::808:808", "2002:a00:1::1", "2002:808:808::1", "2001:db8::1",
    "2001::1", "2606:4700::1111", "3fff::1", "garbage",
  ];
  it.each(sample)("should classify %s identically", (ip) => {
    expect(containerIsPublic(ip)).toBe(apiIsPublic(ip));
  });
});

/** Emulates Node's connect: IP literals skip `lookup`, names go through it. */
function fakeNet(dns: Record<string, string[]>, routes: Record<string, () => HopResponse>) {
  const connected: string[] = [];
  const resolve: Resolver = async (hostname) => {
    const addresses = dns[hostname];
    if (!addresses) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const request: Requester = async (url: URL, lookup: LookupFunction) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const address = isIP(host)
      ? host
      : await new Promise<string>((ok, fail) =>
          lookup(host, { all: true }, (err, result) => {
            if (err) return fail(err);
            ok(Array.isArray(result) ? (result[0]?.address ?? "") : result);
          }),
        );
    connected.push(address);
    const route = routes[`${url.host}${url.pathname}`];
    return route ? route() : reply(404);
  };
  return { resolve, request, connected };
}

function reply(status: number, body: Readable | string = "", location?: string, contentLength?: number): HopResponse {
  return {
    status,
    location,
    contentLength,
    body: typeof body === "string" ? Readable.from([Buffer.from(body)]) : body,
  };
}

const opts = { maxBytes: 1024, idleTimeoutMs: 1000 };

describe("safeDownloadToFile", () => {
  let dir: string;
  let dest: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "safe-download-test-"));
    dest = path.join(dir, "master.mp4");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("should download a public URL to disk", async () => {
    const net = fakeNet({ "videos.example.com": ["93.184.216.34"] }, { "videos.example.com/v.mp4": () => reply(200, "VIDEO") });
    await safeDownloadToFile("https://videos.example.com/v.mp4", dest, opts, net);
    expect(await readFile(dest, "utf8")).toBe("VIDEO");
    expect(net.connected).toEqual(["93.184.216.34"]);
  });

  it("should follow Drive-style redirects between public hosts", async () => {
    const net = fakeNet(
      { "drive.usercontent.google.com": ["142.250.75.225"], "doc-0s.googleusercontent.com": ["142.250.75.226"] },
      {
        "drive.usercontent.google.com/download": () => reply(303, "", "https://doc-0s.googleusercontent.com/f/abc"),
        "doc-0s.googleusercontent.com/f/abc": () => reply(200, "DRIVE"),
      },
    );
    await safeDownloadToFile("https://drive.usercontent.google.com/download?id=x&confirm=t", dest, opts, net);
    expect(await readFile(dest, "utf8")).toBe("DRIVE");
  });

  it.each([
    ["metadata IP", "http://169.254.169.254/latest/meta-data/"],
    ["IPv4-mapped metadata", "http://[::ffff:169.254.169.254]/"],
    ["IPv6 ULA", "http://[fd00::1]/v.mp4"],
    ["CGNAT", "http://100.64.0.1/v.mp4"],
    ["loopback", "http://127.0.0.1:8080/"],
    ["NAT64 of a private IPv4", "http://[64:ff9b::a00:1]/"],
  ])("should refuse a %s URL without connecting", async (_label, url) => {
    const net = fakeNet({}, {});
    await expect(safeDownloadToFile(url, dest, opts, net)).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(net.connected).toEqual([]);
  });

  it("should refuse a name that resolves to a private address", async () => {
    const net = fakeNet({ "videos.attacker.example": ["10.0.0.7"] }, {});
    await expect(safeDownloadToFile("https://videos.attacker.example/v.mp4", dest, opts, net)).rejects.toThrow(
      /non-public address/,
    );
    expect(net.connected).toEqual([]);
  });

  it("should refuse a redirect to the metadata endpoint", async () => {
    const net = fakeNet(
      { "videos.example.com": ["93.184.216.34"] },
      {
        "videos.example.com/v.mp4": () => reply(302, "", "http://169.254.169.254/latest/meta-data/"),
        "169.254.169.254/latest/meta-data/": () => reply(200, "SECRET"),
      },
    );
    await expect(safeDownloadToFile("https://videos.example.com/v.mp4", dest, opts, net)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    expect(net.connected).toEqual(["93.184.216.34"]);
  });

  it("should refuse a redirect to a name that resolves privately", async () => {
    const net = fakeNet(
      { "videos.example.com": ["93.184.216.34"], "rebind.example": ["192.168.1.10"] },
      { "videos.example.com/v.mp4": () => reply(302, "", "https://rebind.example/x") },
    );
    await expect(safeDownloadToFile("https://videos.example.com/v.mp4", dest, opts, net)).rejects.toThrow(
      /non-public address/,
    );
  });

  it("should refuse non-http schemes", async () => {
    const net = fakeNet({}, {});
    await expect(safeDownloadToFile("file:///etc/passwd", dest, opts, net)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("should give up after the redirect limit", async () => {
    const net = fakeNet(
      { "videos.example.com": ["93.184.216.34"] },
      { "videos.example.com/loop": () => reply(302, "", "/loop") },
    );
    await expect(
      safeDownloadToFile("https://videos.example.com/loop", dest, { ...opts, maxRedirects: 2 }, net),
    ).rejects.toThrow(/redirects/);
  });

  it("should refuse a declared Content-Length over the limit", async () => {
    const net = fakeNet(
      { "videos.example.com": ["93.184.216.34"] },
      { "videos.example.com/big": () => reply(200, "x", undefined, 10_000) },
    );
    await expect(safeDownloadToFile("https://videos.example.com/big", dest, opts, net)).rejects.toThrow(/limit/);
  });

  it("should abort a streamed body once it crosses the limit", async () => {
    let produced = 0;
    const endless = new Readable({
      read() {
        produced++;
        this.push(Buffer.alloc(256));
      },
    });
    const net = fakeNet(
      { "videos.example.com": ["93.184.216.34"] },
      { "videos.example.com/stream": () => reply(200, endless) },
    );
    await expect(safeDownloadToFile("https://videos.example.com/stream", dest, opts, net)).rejects.toThrow(/limit/);
    // Stream read-ahead pulls a few buffers past the 1 KiB cap; it must still
    // stop instead of consuming the endless source.
    expect(produced * 256).toBeLessThan(1024 * 1024);
  });

  it("should abort when the body stalls past the idle timeout", async () => {
    const stalled = new Readable({ read() {} });
    const net = fakeNet(
      { "videos.example.com": ["93.184.216.34"] },
      { "videos.example.com/slow": () => reply(200, stalled) },
    );
    await expect(
      safeDownloadToFile("https://videos.example.com/slow", dest, { ...opts, idleTimeoutMs: 30 }, net),
    ).rejects.toThrow();
  });

  it("should report an HTTP error status", async () => {
    const net = fakeNet({ "videos.example.com": ["93.184.216.34"] }, {});
    await expect(safeDownloadToFile("https://videos.example.com/missing", dest, opts, net)).rejects.toThrow(/HTTP 404/);
  });
});
