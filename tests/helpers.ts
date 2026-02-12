import { app } from "../src/index.ts";

/**
 * Create a test client that makes requests to the Hono app
 * without starting a real HTTP server.
 */
export async function testRequest(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = new URL(path, "http://localhost");
  return await app.fetch(new Request(url.toString(), options));
}

export async function testJson<T = any>(path: string, options: RequestInit = {}) {
  const res = await testRequest(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = (await res.json()) as T;
  return { status: res.status, body, headers: res.headers };
}
