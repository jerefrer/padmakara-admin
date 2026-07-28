import { describe, it, expect } from "vitest";
import { storageEnvForContainer } from "../../src/services/s3.ts";

describe("storageEnvForContainer", () => {
  it("maps storage config to the container's S3_* env vars", () => {
    const env = storageEnvForContainer({
      endpoint: "https://acct.r2.cloudflarestorage.com",
      accessKeyId: "r2-key",
      secretAccessKey: "r2-secret",
      region: "auto",
    });
    expect(env).toEqual([
      { name: "S3_ENDPOINT", value: "https://acct.r2.cloudflarestorage.com" },
      { name: "S3_ACCESS_KEY_ID", value: "r2-key" },
      { name: "S3_SECRET_ACCESS_KEY", value: "r2-secret" },
      { name: "S3_REGION", value: "auto" },
    ]);
  });

  it("emits empty S3_ENDPOINT when unset (container stays on AWS role)", () => {
    const env = storageEnvForContainer({
      endpoint: "", accessKeyId: "", secretAccessKey: "", region: "eu-west-3",
    });
    expect(env.find((e) => e.name === "S3_ENDPOINT")!.value).toBe("");
  });
});
