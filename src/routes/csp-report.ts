import { Hono } from "hono";
import { authIpLimiter } from "../middleware/rate-limit.ts";
import {
  browserFamily,
  parseCspPayload,
  recordCspViolation,
} from "../services/csp-reports.ts";

/**
 * Public endpoint the browsers' Content-Security-Policy-Report-Only header
 * points at. No auth: browsers send reports without credentials.
 */
const cspReportRoutes = new Hono();

/** A report is a few hundred bytes; this is generous. The global limit is 1 MB. */
export const CSP_REPORT_MAX_BYTES = 16 * 1024;

/** Read the body as text, or null as soon as it exceeds the cap. */
async function readCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * POST /api/csp-report
 *
 * Accepts `application/csp-report` (report-uri) and `application/reports+json`
 * (Reporting API). Answers 204 whatever the content, even garbage, because the
 * browser ignores the response and there is nothing useful to tell it.
 */
cspReportRoutes.post("/", authIpLimiter({ limit: 120, windowMs: 60 * 1000 }), async (c) => {
  const text = await readCapped(c.req.raw, CSP_REPORT_MAX_BYTES);
  if (text === null) {
    return c.json({ error: "Request body too large", code: "PAYLOAD_TOO_LARGE" }, 413);
  }
  const violations = parseCspPayload(text);
  if (violations.length > 0) {
    const browser = browserFamily(c.req.header("user-agent"));
    try {
      for (const v of violations) await recordCspViolation(v, browser);
    } catch (err) {
      // A storage failure must not turn into an error page for the browser.
      console.error("csp report not stored", err);
    }
  }
  return c.body(null, 204);
});

export { cspReportRoutes };
