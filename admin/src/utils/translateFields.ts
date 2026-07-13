import { authFetch } from "./authFetch";

const API_URL = "/api/admin";

export type TranslateDirection = "en-to-pt" | "pt-to-en";

/**
 * Translate a set of fields EN<->PT via the stateless admin translate endpoint.
 * `items` maps an arbitrary field key to its source text; the resolved object
 * maps the same keys to translated text.
 */
export async function translateFields(
  direction: TranslateDirection,
  items: Record<string, string>,
): Promise<Record<string, string>> {
  const res = await authFetch(`${API_URL}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction, items }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `Translation failed (${res.status})`);
  }
  const data = (await res.json()) as { translations: Record<string, string> };
  return data.translations;
}
