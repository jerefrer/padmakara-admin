/**
 * Humanizes raw AWS Batch / infra error strings for display in the admin UI.
 *
 * The Batch reconciler (see `src/services/batch-reconcile.ts`) stores whatever
 * raw reason AWS gives us in `error_message` — useful for debugging, but not
 * something a non-technical admin should have to parse ("Essential container
 * in task exited"). This maps known-technical phrases to a friendly sentence,
 * defaulting to a generic-but-actionable message for anything unrecognized
 * (including an empty/missing error).
 *
 * Callers keep the raw text available (e.g. as a tooltip) for technical users.
 */

export type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * Prefix the alignment pipeline puts on problems an administrator can act on —
 * a missing transcript, the wrong transcript, markers that do not match the
 * audio. These are written for a person and must survive to the screen; without
 * this check they fell through to "the job crashed", which tells nobody
 * anything.
 */
const TRANSCRIPT_PROBLEM = "transcript problem";

export function friendlyJobError(raw: string | null | undefined, translate: TranslateFn): string {
  const text = (raw ?? "").toLowerCase();

  if (text.startsWith(TRANSCRIPT_PROBLEM)) {
    const dash = (raw ?? "").indexOf("\u2014");
    const detail = dash === -1 ? (raw ?? "") : (raw ?? "").slice(dash + 1).trim();
    return `${translate("padmakara.jobErrors.transcript")} — ${detail}`;
  }

  if (text.includes("cancelled by")) {
    return translate("padmakara.jobErrors.cancelled");
  }

  if (text.includes("aged out") || text.includes("no longer tracked")) {
    return translate("padmakara.jobErrors.agedOut");
  }

  if (text.includes("succeeded but its completion callback")) {
    return translate("padmakara.jobErrors.missingCallback");
  }

  // Covers "Essential container in task exited", "container exited",
  // "Batch job …" and anything else unrecognized (including empty).
  return translate("padmakara.jobErrors.crashed");
}
