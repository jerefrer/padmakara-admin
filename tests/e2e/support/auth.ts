import { testJson } from "../../helpers.ts";

/**
 * Mints a JWT for a seeded test user via the env-gated POST /api/test/token route,
 * so e2e tests authenticate without the magic-link flow.
 */
export async function tokenForUser(user: {
  id: number;
  email: string;
  role: string;
}): Promise<string> {
  const { status, body } = await testJson<{ token: string }>("/api/test/token", {
    method: "POST",
    body: JSON.stringify({ userId: user.id, email: user.email, role: user.role }),
  });
  if (status !== 200 || typeof body.token !== "string") {
    throw new Error(`tokenForUser failed: status ${status}`);
  }
  return body.token;
}

/** Builds the Authorization header for an authenticated e2e request. */
export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}
