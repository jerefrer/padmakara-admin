/** i18n keys for API error codes the admin explains in its own words. */
const ERROR_KEYS: Record<string, string> = {
  FEATURED_EVENT_LOCKED: "padmakara.events.featuredEventLocked",
  EVENT_NOT_PUBLISHED: "padmakara.events.featuredNotPublished",
};

/** The i18n key for an API error code, or the generic error key when it has no dedicated message. */
export function apiErrorMessageKey(error: { code?: string; body?: { code?: string } } | null | undefined): string {
  const code = error?.code ?? error?.body?.code;
  return (code && ERROR_KEYS[code]) || "padmakara.common.error";
}

export function isMappedApiError(code: string | undefined): code is string {
  return !!code && code in ERROR_KEYS;
}

interface ApiErrorBody {
  error?: string;
  issues?: { path?: (string | number)[]; message?: string }[];
}

/**
 * Human-readable text for a failed API call. react-admin's fetchJson uses the
 * response's `message` field or its status text, but our API answers
 * `{ error, code, issues? }`, and HTTP/2 responses carry no status text, so
 * without this the notification ends with nothing after "Error: ".
 */
export function apiErrorText(message: string, body: unknown): string {
  const b = (body ?? {}) as ApiErrorBody;
  if (!b.error) return message;
  const issues = (b.issues ?? [])
    .map((i) => `${(i.path ?? []).join(".")}: ${i.message ?? ""}`)
    .join("; ");
  return issues ? `${b.error}: ${issues}` : b.error;
}
