/**
 * Authenticated fetch with transparent access-token refresh.
 *
 * When a request returns 401, we exchange the long-lived refresh token for a
 * fresh access token and retry the original request once. Concurrent requests
 * share a single in-flight refresh so the server-side rotation (which
 * invalidates the old refresh token on each call) doesn't cause a stampede.
 */

const REFRESH_URL = "/api/auth/refresh";

let inFlightRefresh: Promise<string | null> | null = null;

function clearAuth(): void {
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("user");
}

async function doRefresh(): Promise<string | null> {
  const refreshToken = localStorage.getItem("refreshToken");
  if (!refreshToken) return null;

  try {
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      clearAuth();
      return null;
    }
    const tokens = (await res.json()) as { accessToken: string; refreshToken: string };
    localStorage.setItem("accessToken", tokens.accessToken);
    localStorage.setItem("refreshToken", tokens.refreshToken);
    return tokens.accessToken;
  } catch {
    return null;
  }
}

export async function refreshAccessToken(): Promise<string | null> {
  if (!inFlightRefresh) {
    inFlightRefresh = doRefresh().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

function withAuthHeaders(init: RequestInit | undefined, token: string | null): RequestInit {
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return { ...(init ?? {}), headers };
}

/**
 * Fetch with an auth header and one-shot refresh-and-retry on 401.
 * Returns the raw Response — caller handles status/JSON parsing.
 */
export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const first = await fetch(url, withAuthHeaders(init, localStorage.getItem("accessToken")));
  if (first.status !== 401) return first;

  const newToken = await refreshAccessToken();
  if (!newToken) return first; // give up; caller sees 401 and routes to login
  return fetch(url, withAuthHeaders(init, newToken));
}
