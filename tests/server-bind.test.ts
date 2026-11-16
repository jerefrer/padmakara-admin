import { describe, it, expect, vi, afterEach } from "vitest";

describe("server bind address", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function hostname(bindHost?: string): Promise<string | undefined> {
    vi.stubEnv("BIND_HOST", bindHost);
    vi.resetModules();
    const server = (await import("../src/index.ts")).default as { hostname?: string };
    return server.hostname;
  }

  it("should listen on the loopback interface only by default, behind the reverse proxy", async () => {
    expect(await hostname()).toBe("127.0.0.1");
  });

  it("should listen on the address given in BIND_HOST", async () => {
    expect(await hostname("0.0.0.0")).toBe("0.0.0.0");
  });
});
