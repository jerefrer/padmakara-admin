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
