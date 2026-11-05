import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uploads = vi.hoisted(() => ({ created: [] as Array<Record<string, any>>, done: vi.fn() }));

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    constructor(options: Record<string, any>) {
      uploads.created.push(options);
    }
    done = uploads.done;
  },
}));

import { uploadFile, UPLOAD_PART_BYTES } from "../../containers/video-burn/s3-client.ts";

describe("uploadFile", () => {
  let dir: string;
  const client = { send: vi.fn() } as never;

  beforeEach(async () => {
    uploads.created.length = 0;
    uploads.done.mockReset();
    uploads.done.mockResolvedValue({});
    dir = await mkdtemp(path.join(tmpdir(), "burn-upload-test-"));
    await writeFile(path.join(dir, "merged.mp4"), "video");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("should send the file through the multipart uploader", async () => {
    await uploadFile(client, "bucket", "video-burn/24/merged.mp4", path.join(dir, "merged.mp4"), "video/mp4");

    expect(uploads.created).toHaveLength(1);
    expect(uploads.created[0]!.client).toBe(client);
    expect(uploads.created[0]!.params).toMatchObject({
      Bucket: "bucket",
      Key: "video-burn/24/merged.mp4",
      ContentType: "video/mp4",
    });
    expect(uploads.done).toHaveBeenCalledTimes(1);
  });

  it("should leave nothing behind when a part fails", async () => {
    uploads.done.mockRejectedValue(new Error("part failed"));

    await expect(
      uploadFile(client, "bucket", "key", path.join(dir, "merged.mp4"), "video/mp4"),
    ).rejects.toThrow("part failed");
    expect(uploads.created[0]!.leavePartsOnError).toBe(false);
  });

  it("should fit the largest file the 200 GiB scratch disk can hold in 10,000 parts", () => {
    expect(UPLOAD_PART_BYTES * 10_000).toBeGreaterThanOrEqual(200 * 1024 ** 3);
  });
});
