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

export function friendlyJobError(raw: string | null | undefined, translate: TranslateFn): string {
  const text = (raw ?? "").toLowerCase();

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
