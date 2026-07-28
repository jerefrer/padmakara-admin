import { describe, it, expect } from "vitest";
import { storageEnvForContainer } from "../../src/services/s3.ts";

// The read-along submitter must spread storageEnvForContainer() into the
// container environment. This guards that the four S3_* names are present.
describe("read-along container env includes storage vars", () => {
  it("storageEnvForContainer exposes the four S3_* names the container reads", () => {
    const names = storageEnvForContainer({
      endpoint: "e", accessKeyId: "k", secretAccessKey: "s", region: "r",
    }).map((e) => e.name);
    expect(names).toContain("S3_ENDPOINT");
    expect(names).toContain("S3_ACCESS_KEY_ID");
    expect(names).toContain("S3_SECRET_ACCESS_KEY");
    expect(names).toContain("S3_REGION");
  });
});
