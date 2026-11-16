/**
 * SSRF-safe download of MASTER_SOURCE_URL.
 *
 * This is a self-contained copy of the rules in the API's
 * src/lib/safe-fetch.ts — the container image only ships src/lib/slides, so
 * it cannot import that file. Keep the two in step:
 * tests/services/video-burn-safe-download.test.ts checks that both classify
 * the same addresses the same way.
 *
 * The URL comes from an admin (POST /admin/videos/import-url). This job runs
 * inside our AWS network and uploads what it downloads to S3, where the admin
 * can read it back, so a URL reaching an internal address (the instance
 * metadata endpoint above all) would leak it. The rules:
 *
 *  1. http(s) only, no credentials in the URL.
 *  2. An IP-literal host must be public unicast (isPublicAddress).
 *  3. A named host is resolved through a validating `lookup` hook passed to
 *     Node's http(s).request: the socket connects only to an address that
 *     hook approved, and every address the name resolves to must be public.
 *     The check is on the address actually connected to, so DNS rebinding
 *     between a check and the connect is not possible. TLS still verifies the
 *     certificate against the hostname.
 *  4. Redirects are followed by hand, each hop re-checked, up to a limit.
 *  5. The body is streamed to disk with a byte cap and an idle timeout.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { createWriteStream } from "node:fs";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ─── Address classification (mirror of src/lib/safe-fetch.ts) ───────────

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

function parseIPv6(raw: string): number[] | null {
  let ip = raw.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4Match = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const v4 = parseIPv4(v4Match[2] ?? "");
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    ip = `${v4Match[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const hextets = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return hextets.length === 8 && hextets.every((h) => !Number.isNaN(h)) ? hextets : null;
}

function v4Int(b: number[]): number {
  const [a = 0, c = 0, d = 0, e = 0] = b;
  return ((a << 24) | (c << 16) | (d << 8) | e) >>> 0;
}

const NON_PUBLIC_V4: [number[], number][] = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

function isPublicV4(b: number[]): boolean {
  const addr = v4Int(b);
  return !NON_PUBLIC_V4.some(([prefix, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) === (v4Int(prefix) & mask);
  });
}

function isPublicV6(h: number[]): boolean {
  const at = (i: number) => h[i] ?? 0;
  const embeddedV4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);

  if (zeros(0, 5) && at(5) === 0xffff) return isPublicV4(embeddedV4(at(6), at(7)));
  if (at(0) === 0x64 && at(1) === 0xff9b && zeros(2, 6)) return isPublicV4(embeddedV4(at(6), at(7)));
  if (at(0) === 0x2002) return isPublicV4(embeddedV4(at(1), at(2)));
  if ((at(0) & 0xe000) !== 0x2000) return false;
  if (at(0) === 0x2001 && at(1) === 0x0db8) return false;
  if (at(0) === 0x2001 && at(1) < 0x0200) return false;
  if (at(0) === 0x3fff && at(1) < 0x1000) return false;
  return true;
}

/** True only for a public unicast IPv4/IPv6 address. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const family = isIP(bare.replace(/%.*$/, ""));
  if (family === 4) {
    const b = parseIPv4(bare);
    return b !== null && isPublicV4(b);
  }
  if (family === 6) {
    const h = parseIPv6(bare);
    return h !== null && isPublicV6(h);
  }
  return false;
}

// ─── Download ────────────────────────────────────────────────────────────

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;
export type LookupFunction = (hostname: string, options: { all?: boolean } | number, callback: LookupCallback) => void;

/**
 * A Node `lookup` hook that only ever hands the socket public addresses, and
 * fails the connection when the name resolves to any non-public one.
 */
export function makeValidatingLookup(resolve: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const first = addresses[0];
        const bad = addresses.find((a) => !isPublicAddress(a.address));
        if (!first || bad) {
          const err: NodeJS.ErrnoException = new UnsafeUrlError(
            bad ? `${hostname} resolves to a non-public address (${bad.address})` : `Could not resolve ${hostname}`,
          );
          err.code = "EUNSAFEADDRESS";
          callback(err, "");
          return;
        }
        const wantsAll = typeof options === "object" && options.all;
        if (wantsAll) callback(null, addresses);
        else callback(null, first.address, first.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ""),
    );
  };
}

export interface HopResponse {
  status: number;
  location: string | undefined;
  contentLength: number | undefined;
  body: Readable;
}

export type Requester = (url: URL, lookup: LookupFunction, signal: AbortSignal) => Promise<HopResponse>;

const nodeRequester: Requester = (url, lookup, signal) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        signal,
        // Node types `lookup` as dns.lookup's overload set, which a single
        // callback-style hook cannot satisfy structurally; it implements the
        // same runtime contract (both the `all` and single-address forms).
        lookup: lookup as unknown as http.RequestOptions["lookup"],
        headers: { "User-Agent": "padmakara-video-burn" },
      },
      (res) => {
        const length = Number(res.headers["content-length"]);
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location,
          contentLength: Number.isFinite(length) ? length : undefined,
          body: res,
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

const defaultResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Scheme, credentials and IP-literal checks; named hosts are checked at connect time. */
export function checkUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError(`URL scheme ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) throw new UnsafeUrlError("URLs with credentials are not allowed");
  // Node does not call `lookup` for an IP-literal host, so check it here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) {
    throw new UnsafeUrlError(`${host} is not a public address`);
  }
  return url;
}

export interface SafeDownloadOptions {
  /** Refuse bodies larger than this (checked against Content-Length and while streaming). */
  maxBytes: number;
  /** Abort when no byte arrives for this long. */
  idleTimeoutMs: number;
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Stream an untrusted URL to `destPath` under the rules at the top of this file. */
export async function safeDownloadToFile(
  rawUrl: string,
  destPath: string,
  options: SafeDownloadOptions,
  deps: { resolve?: Resolver; request?: Requester } = {},
): Promise<void> {
  const lookup = makeValidatingLookup(deps.resolve ?? defaultResolver);
  const request = deps.request ?? nodeRequester;
  const maxRedirects = options.maxRedirects ?? 5;

  const controller = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () => controller.abort(new Error(`No data for ${options.idleTimeoutMs}ms`)),
      options.idleTimeoutMs,
    );
  };

  try {
    let current = rawUrl;
    for (let hop = 0; ; hop++) {
      const url = checkUrlShape(current);
      touch();
      const res = await request(url, lookup, controller.signal);

      if (REDIRECT_STATUSES.has(res.status)) {
        res.body.resume();
        if (!res.location) throw new Error(`Redirect without a Location (HTTP ${res.status})`);
        if (hop >= maxRedirects) throw new Error(`More than ${maxRedirects} redirects`);
        current = new URL(res.location, url).href;
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        res.body.resume();
        throw new Error(`Failed to download master from URL: HTTP ${res.status}`);
      }
      if (res.contentLength !== undefined && res.contentLength > options.maxBytes) {
        res.body.destroy();
        throw new Error(`Master is ${res.contentLength} bytes, over the ${options.maxBytes}-byte limit`);
      }

      let total = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          total += chunk.length;
          touch();
          if (total > options.maxBytes) {
            done(new Error(`Master exceeds the ${options.maxBytes}-byte limit`));
            return;
          }
          done(null, chunk);
        },
      });
      await pipeline(res.body, cap, createWriteStream(destPath), { signal: controller.signal });
      return;
    }
  } finally {
    clearTimeout(idle);
  }
}
