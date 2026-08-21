/**
 * Completion webhook POST for the burn container. Same HMAC-SHA256 scheme
 * as the backend's /api/webhooks/read-along and /api/webhooks/subtitles —
 * see the X-Webhook-Signature verification in src/routes/webhooks.ts.
 */

import { createHmac } from "node:crypto";

export interface VideoBurnWebhookPayload {
  jobId: string;
  videoId: number;
  status: "completed" | "failed";
  bunnyVideoId?: string;
  introMs?: number;
  outroMs?: number;
  /**
   * S3 key of the retained, untouched master recording. Always present on a
   * successful burn — for the MASTER_S3_KEY path it's the same key the
   * backend already knows; for the MASTER_SOURCE_URL path (see source.ts)
   * it's the key the container just uploaded the downloaded original to.
   * The backend persists it onto the row when present (src/routes/webhooks.ts).
   */
  masterS3Key?: string;
  /** Non-fatal problem (e.g. thumbnail extraction failed) — job still succeeded. */
  warning?: string;
  error?: string;
}

/**
 * POST the completion/failure webhook. Never throws — a failed webhook
 * delivery must not crash an otherwise-successful run, and on a genuinely
 * failed run we're already in the terminal error path. The backend's
 * reconcileVideoBurnRows() (src/services/video-burn.ts) is the safety net
 * for a webhook that never arrives at all.
 */
export async function postWebhook(
  url: string,
  secret: string,
  payload: VideoBurnWebhookPayload,
): Promise<void> {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Signature": signature },
      body: rawBody,
    });
    if (!res.ok) {
      console.error(`[video-burn] webhook POST returned ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    console.error("[video-burn] failed to POST completion webhook:", err);
  }
}
