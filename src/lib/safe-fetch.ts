import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetching a URL an admin typed in, without letting it reach our own network.
 *
 * Every server-side fetch of an admin-supplied URL goes through here (the
 * legacy photo/logo re-crop source, the video import URL check). A string
 * denylist on the hostname is not enough: a public host can redirect to
 * 169.254.169.254, a DNS name can resolve to 10.0.0.5, and an address has many
 * spellings ([::ffff:169.254.169.254], 2130706433, [fd00::1]…). So:
 *
 *  1. Only http(s) is accepted (http only when the caller opts in), and no
 *     credentials in the URL.
 *  2. The hostname is resolved, and EVERY address it resolves to must be
 *     public unicast (see isPublicAddress). One private answer refuses it.
 *  3. The request is pinned to the address we validated: we connect to the IP
 *     itself and send the real hostname in the Host header and as the TLS
 *     server name (Bun's fetch then verifies the certificate against that
 *     name, not the IP). A DNS answer that changes between our check and the
 *     connect (DNS rebinding) therefore cannot redirect the connection.
 *  4. Redirects are followed by hand, re-running 1–3 on every hop, up to a
 *     hop limit; an https → http downgrade is refused unless http is allowed.
 *  5. A total timeout, and a maximum body size enforced while streaming (the
 *     read is cancelled as soon as the limit is crossed).
 *
 * Residual risk, stated honestly: pinning relies on Bun's `fetch` honouring
 * `tls.serverName` for certificate verification (verified by hand against a
 * local TLS server on Bun 1.3: a mismatching name is refused). If an
 * HTTP(S)_PROXY environment variable is ever set on the API host, Bun sends
 * the request through that proxy and the proxy does its own DNS — pinning
 * would then be the proxy's job. The container copy of this logic
 * (containers/video-burn/safe-download.ts) pins through Node's `lookup` hook.
 */

/** Why a safe fetch failed. `blocked` means the URL itself was refused. */
export type SafeFetchFailure =
  | "blocked"
  | "too_many_redirects"
  | "http_status"
  | "too_large"
  | "bad_content_type"
  | "timeout"
  | "network";

export class SafeFetchError extends Error {
  constructor(
    readonly reason: SafeFetchFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

// ─── Address classification ─────────────────────────────────────────────

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

/** Expand an IPv6 address (any textual form, with or without brackets/zone) to 8 hextets. */
function parseIPv6(raw: string): number[] | null {
  let ip = raw.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two hextets.
  const v4Match = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const v4 = parseIPv4(v4Match[2]!);
    if (!v4) return null;
    ip = `${v4Match[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
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

function inV4(b: number[], prefix: [number, number, number, number], bits: number): boolean {
  const addr = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  const net = ((prefix[0] << 24) | (prefix[1] << 16) | (prefix[2] << 8) | prefix[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) === (net & mask);
}

/** IPv4 ranges that are not publicly routable unicast (IANA special-purpose registry). */
const NON_PUBLIC_V4: [[number, number, number, number], number][] = [
  [[0, 0, 0, 0], 8], // "this network", incl. 0.0.0.0
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, incl. cloud metadata
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24], // documentation
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, incl. broadcast
];

function isPublicV4(b: number[]): boolean {
  return !NON_PUBLIC_V4.some(([prefix, bits]) => inV4(b, prefix, bits));
}

function isPublicV6(h: number[]): boolean {
  const embeddedV4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);

  // IPv4-mapped ::ffff:a.b.c.d — judged as the IPv4 address it reaches.
  if (zeros(0, 5) && h[5] === 0xffff) return isPublicV4(embeddedV4(h[6]!, h[7]!));
  // NAT64 well-known prefix 64:ff9b::/96 — likewise.
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return isPublicV4(embeddedV4(h[6]!, h[7]!));
  // 6to4 2002:a.b.c.d::/48 — likewise.
  if (h[0] === 0x2002) return isPublicV4(embeddedV4(h[1]!, h[2]!));

  // Everything else must be global unicast 2000::/3. That alone rules out
  // :: and ::1, IPv4-compatible ::a.b.c.d, fc00::/7 (ULA), fe80::/10
  // (link-local), ff00::/8 (multicast) and 64:ff9b:1::/48 (local NAT64).
  if ((h[0]! & 0xe000) !== 0x2000) return false;
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false; // documentation
  if (h[0] === 0x2001 && h[1]! < 0x0200) return false; // 2001::/23 IETF special (Teredo, ORCHID, benchmarking…)
  if (h[0] === 0x3fff && h[1]! < 0x1000) return false; // 3fff::/20 documentation
  return true;
}

/**
 * True only for a public unicast IPv4/IPv6 address. Anything unparseable is
 * not public. Exported for tests and for callers that already hold an IP.
 */
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

// ─── URL validation ──────────────────────────────────────────────────────

export interface UrlPolicy {
  /** Accept plain http as well as https. Off by default. */
  allowHttp?: boolean;
}

export interface ValidatedTarget {
  url: URL;
  /** The public address the request must be sent to. */
  address: string;
  family: 4 | 6;
}

/**
 * Check a URL's scheme and resolve its host, refusing anything that is (or
 * resolves to) a non-public address. Returns the address to pin the request
 * to. Throws SafeFetchError("blocked") on refusal.
 */
export async function validatePublicUrl(raw: string | URL, policy: UrlPolicy = {}): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("blocked", "Not a valid URL");
  }
  const schemes = policy.allowHttp ? ["https:", "http:"] : ["https:"];
  if (!schemes.includes(url.protocol)) {
    throw new SafeFetchError("blocked", `URL scheme ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) {
    throw new SafeFetchError("blocked", "URLs with credentials are not allowed");
  }

  // WHATWG URL parsing already normalised odd IPv4 spellings (0x7f.1,
  // 2130706433…) to dotted form and wraps IPv6 literals in brackets.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new SafeFetchError("blocked", `Could not resolve ${host}`);
    }
  }
  if (addresses.length === 0) throw new SafeFetchError("blocked", `Could not resolve ${host}`);
  const bad = addresses.find((a) => !isPublicAddress(a.address));
  if (bad) {
    throw new SafeFetchError("blocked", `${host} points at a non-public address (${bad.address})`);
  }
  const first = addresses[0]!;
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}

// ─── Fetch ───────────────────────────────────────────────────────────────

export interface SafeFetchOptions extends UrlPolicy {
  /** Abort the whole exchange (all hops + body) after this many ms. */
  timeoutMs: number;
  /** Refuse bodies larger than this, checked while streaming. */
  maxBytes: number;
  /** Redirect hops allowed before giving up. Default 5. */
  maxRedirects?: number;
  /** Optional check on the final response's Content-Type (lower-cased, may be ""). */
  acceptContentType?: (contentType: string) => boolean;
}

export interface SafeFetchResult {
  /** The final URL after redirects. */
  url: URL;
  contentType: string;
  body: Uint8Array;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** One request to a validated, pinned target. Never follows redirects itself. */
async function requestPinned(target: ValidatedTarget, signal: AbortSignal): Promise<Response> {
  const { url, address, family } = target;
  const pinned = new URL(url);
  pinned.hostname = family === 6 ? `[${address}]` : address;
  // `tls` is Bun's fetch extension (BunFetchRequestInit); plain RequestInit does not declare it.
  const init: RequestInit & { tls?: { serverName?: string } } = {
    method: "GET",
    redirect: "manual",
    signal,
    headers: { Host: url.host, "User-Agent": "padmakara-api" },
  };
  if (url.protocol === "https:") init.tls = { serverName: url.hostname };
  return fetch(pinned, init);
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new SafeFetchError("too_large", `Response is ${declared} bytes, over the ${maxBytes}-byte limit`);
  }
  if (!res.body) return new Uint8Array(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SafeFetchError("too_large", `Response exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * GET an untrusted URL and return its body, under the rules at the top of
 * this file. Throws SafeFetchError for every refusal or failure.
 */
export async function safeFetch(raw: string | URL, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const signal = AbortSignal.timeout(options.timeoutMs);

  try {
    let current = String(raw);
    for (let hop = 0; ; hop++) {
      const target = await validatePublicUrl(current, options);
      let res: Response;
      try {
        res = await requestPinned(target, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        throw new SafeFetchError("network", `Request to ${target.url.host} failed: ${(err as Error).message}`);
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location) throw new SafeFetchError("http_status", `Redirect without a Location (HTTP ${res.status})`, res.status);
        if (hop >= maxRedirects) throw new SafeFetchError("too_many_redirects", `More than ${maxRedirects} redirects`);
        current = new URL(location, target.url).href;
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new SafeFetchError("http_status", `HTTP ${res.status}`, res.status);
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (options.acceptContentType && !options.acceptContentType(contentType)) {
        await res.body?.cancel().catch(() => {});
        throw new SafeFetchError("bad_content_type", `Unexpected content type "${contentType}"`);
      }
      const body = await readCapped(res, options.maxBytes);
      return { url: target.url, contentType, body };
    }
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    if (signal.aborted) throw new SafeFetchError("timeout", `Timed out after ${options.timeoutMs}ms`);
    throw new SafeFetchError("network", (err as Error).message ?? String(err));
  }
}
