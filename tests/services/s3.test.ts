import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "stream";

// The AWS SDK client, presigner and multipart uploader are mocked; the
// Command classes stay real so tests can assert on the exact input sent.
const { sendMock, getSignedUrlMock, uploadCtorMock, uploadDoneMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getSignedUrlMock: vi.fn(),
  uploadCtorMock: vi.fn(),
  uploadDoneMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  class S3Client {
    send = sendMock;
  }
  return { ...actual, S3Client };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    constructor(opts: unknown) {
      uploadCtorMock(opts);
    }
    done = uploadDoneMock;
  },
}));

import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import {
  buildTrackS3Key,
  buildReadAlongS3Key,
  buildTranscriptS3Key,
  buildZipS3Key,
  buildTeacherAvatarS3Key,
  buildTeacherHeroS3Key,
  buildTeacherHeroMobileS3Key,
  buildGroupAvatarS3Key,
  buildGroupHeroS3Key,
  buildGroupHeroMobileS3Key,
  isCacheableKey,
  generatePresignedDownloadUrl,
  generatePresignedUploadUrl,
  generatePresignedAttachmentUrl,
  getObjectStream,
  getObjectText,
  getObjectBytes,
  listObjects,
  deleteObject,
  putObject,
  copyObjectIntoAppBucket,
  uploadStream,
} from "../../src/services/s3.ts";
import { config } from "../../src/config.ts";

const BUCKET = config.storage.bucket;

/** The command object passed to the n-th send() call. */
function sentCommand(n = 0) {
  return sendMock.mock.calls[n]![0];
}

let signCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  signCounter = 0;
  getSignedUrlMock.mockImplementation(async (_client: unknown, command: { input: { Key: string } }) => {
    signCounter++;
    return `https://storage.test/${command.input.Key}?sig=${signCounter}`;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("key builders", () => {
  it("should build a flat per-event track key, ignoring the session number", () => {
    expect(buildTrackS3Key("EVT-01", 1, "001 JKR - Intro.mp3")).toBe("events/EVT-01/001 JKR - Intro.mp3");
    expect(buildTrackS3Key("EVT-01", 7, "a.mp3")).toBe(buildTrackS3Key("EVT-01", 1, "a.mp3"));
  });

  it("should build transcript and read-along keys under the event prefix", () => {
    expect(buildTranscriptS3Key("EVT-01", "t.pdf")).toBe("events/EVT-01/transcripts/t.pdf");
    expect(buildReadAlongS3Key("EVT-01", "track.json")).toBe("events/EVT-01/read-along/track.json");
  });

  it("should name a ZIP after the slug when given, else after the request id", () => {
    expect(buildZipS3Key("EVT-01", "req-1", "spring-retreat")).toBe("downloads/EVT-01/spring-retreat.zip");
    expect(buildZipS3Key("EVT-01", "req-1")).toBe("downloads/EVT-01/req-1.zip");
    expect(buildZipS3Key("EVT-01", "req-1", "")).toBe("downloads/EVT-01/req-1.zip");
  });

  it("should timestamp image keys so a replaced image gets a new key", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1716800000000);

    expect(buildTeacherAvatarS3Key(4, "jpg")).toBe("teachers/avatars/4-1716800000000.jpg");
    expect(buildTeacherHeroS3Key(4, "jpg")).toBe("teachers/heroes/4-1716800000000.jpg");
    expect(buildTeacherHeroMobileS3Key(4, "jpg")).toBe("teachers/heroes/4-1716800000000-m.jpg");
    expect(buildGroupAvatarS3Key(9, "png")).toBe("groups/avatars/9-1716800000000.png");
    expect(buildGroupHeroS3Key(9, "png")).toBe("groups/heroes/9-1716800000000.png");
    expect(buildGroupHeroMobileS3Key(9, "png")).toBe("groups/heroes/9-1716800000000-m.png");
  });

  it("should produce image keys that the presigned-URL cache accepts", () => {
    expect(isCacheableKey(buildTeacherAvatarS3Key(1, "jpg"))).toBe(true);
    expect(isCacheableKey(buildGroupHeroMobileS3Key(1, "jpg"))).toBe(true);
    expect(isCacheableKey(buildZipS3Key("EVT", "r"))).toBe(false);
    expect(isCacheableKey(buildTrackS3Key("EVT", 1, "a.mp3"))).toBe(false);
  });
});

describe("generatePresignedDownloadUrl", () => {
  it("should sign a GetObject for the configured bucket with the requested expiry", async () => {
    const url = await generatePresignedDownloadUrl("downloads/EVT/x.zip", 7200);

    expect(url).toBe("https://storage.test/downloads/EVT/x.zip?sig=1");
    const [, command, options] = getSignedUrlMock.mock.calls[0]!;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({ Bucket: BUCKET, Key: "downloads/EVT/x.zip" });
    expect(options).toEqual({ expiresIn: 7200 });
  });

  it("should default to a one-hour expiry", async () => {
    await generatePresignedDownloadUrl("events/EVT/a.mp3");

    expect(getSignedUrlMock.mock.calls[0]![2]).toEqual({ expiresIn: 3600 });
  });

  it("should never cache audio URLs (a fresh signature every call)", async () => {
    const first = await generatePresignedDownloadUrl("events/EVT/never-cached.mp3");
    const second = await generatePresignedDownloadUrl("events/EVT/never-cached.mp3");

    expect(first).not.toBe(second);
    expect(getSignedUrlMock).toHaveBeenCalledTimes(2);
  });

  it("should reuse an image URL for half of its lifetime, then re-sign", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const key = "teachers/avatars/77-cache-test.jpg";

    const first = await generatePresignedDownloadUrl(key, 600);
    vi.setSystemTime(new Date("2026-01-01T00:04:59Z")); // < 300 s later
    const stillCached = await generatePresignedDownloadUrl(key, 600);
    vi.setSystemTime(new Date("2026-01-01T00:05:01Z")); // > 300 s later
    const refreshed = await generatePresignedDownloadUrl(key, 600);

    expect(stillCached).toBe(first);
    expect(refreshed).not.toBe(first);
    expect(getSignedUrlMock).toHaveBeenCalledTimes(2);
  });

  it("should propagate a signing failure", async () => {
    getSignedUrlMock.mockRejectedValueOnce(new Error("bad credentials"));

    await expect(generatePresignedDownloadUrl("events/EVT/a.mp3")).rejects.toThrow("bad credentials");
  });
});

describe("generatePresignedUploadUrl", () => {
  it("should sign a PutObject that pins the content type", async () => {
    await generatePresignedUploadUrl("events/EVT/a.mp3", "audio/mpeg", 900);

    const [, command, options] = getSignedUrlMock.mock.calls[0]!;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({ Bucket: BUCKET, Key: "events/EVT/a.mp3", ContentType: "audio/mpeg" });
    expect(options).toEqual({ expiresIn: 900 });
  });
});

describe("generatePresignedAttachmentUrl", () => {
  it("should ask for an attachment disposition with the given filename", async () => {
    await generatePresignedAttachmentUrl("events/EVT/t.pdf", "Transcrição.pdf");

    const [, command, options] = getSignedUrlMock.mock.calls[0]!;
    expect(command.input.ResponseContentDisposition).toBe('attachment; filename="Transcrição.pdf"');
    expect(options).toEqual({ expiresIn: 600 });
  });

  it("should strip double quotes so the filename cannot break out of the header value", async () => {
    await generatePresignedAttachmentUrl("events/EVT/t.pdf", 'a"; filename="evil.exe');

    const command = getSignedUrlMock.mock.calls[0]![1];
    expect(command.input.ResponseContentDisposition).toBe('attachment; filename="a; filename=evil.exe"');
  });
});

describe("object reads", () => {
  it("should return the response body as the stream for ZIP generation", async () => {
    const body = Readable.from(Buffer.from("audio"));
    sendMock.mockResolvedValueOnce({ Body: body });

    const stream = await getObjectStream("events/EVT/a.mp3");

    expect(stream).toBe(body);
    expect(sentCommand()).toBeInstanceOf(GetObjectCommand);
    expect(sentCommand().input).toEqual({ Bucket: BUCKET, Key: "events/EVT/a.mp3" });
  });

  it("should throw a descriptive error when the stream response has no body", async () => {
    sendMock.mockResolvedValueOnce({});

    await expect(getObjectStream("events/EVT/a.mp3")).rejects.toThrow(
      "No body returned for S3 object: events/EVT/a.mp3",
    );
  });

  it("should propagate a missing-object error from the client", async () => {
    sendMock.mockRejectedValueOnce(Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }));

    await expect(getObjectStream("events/EVT/gone.mp3")).rejects.toThrow("NoSuchKey");
  });

  it("should decode an object body as UTF-8 text", async () => {
    const transformToString = vi.fn(async () => '{"ok":true}');
    sendMock.mockResolvedValueOnce({ Body: { transformToString } });

    const text = await getObjectText("events/EVT/read-along/a.json");

    expect(text).toBe('{"ok":true}');
    expect(transformToString).toHaveBeenCalledWith("utf-8");
  });

  it("should throw when a text read has no body", async () => {
    sendMock.mockResolvedValueOnce({ Body: undefined });

    await expect(getObjectText("k")).rejects.toThrow("No body returned for S3 object: k");
  });

  it("should return bytes with the stored content type", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    sendMock.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => bytes },
      ContentType: "image/jpeg",
    });

    expect(await getObjectBytes("teachers/avatars/1.jpg")).toEqual({ body: bytes, contentType: "image/jpeg" });
  });

  it("should fall back to application/octet-stream when no content type is stored", async () => {
    sendMock.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array() } });

    const { contentType } = await getObjectBytes("x");

    expect(contentType).toBe("application/octet-stream");
  });
});

describe("listObjects", () => {
  it("should follow continuation tokens until the listing is exhausted", async () => {
    const d = new Date("2026-01-01");
    sendMock
      .mockResolvedValueOnce({
        Contents: [{ Key: "events/EVT/a.mp3", Size: 10, LastModified: d }],
        NextContinuationToken: "page-2",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "events/EVT/b.mp3", Size: 20, LastModified: d }],
      });

    const result = await listObjects("events/EVT/");

    expect(result).toEqual([
      { key: "events/EVT/a.mp3", size: 10, lastModified: d },
      { key: "events/EVT/b.mp3", size: 20, lastModified: d },
    ]);
    expect(sentCommand(0)).toBeInstanceOf(ListObjectsV2Command);
    expect(sentCommand(0).input).toEqual({ Bucket: BUCKET, Prefix: "events/EVT/", ContinuationToken: undefined });
    expect(sentCommand(1).input.ContinuationToken).toBe("page-2");
  });

  it("should return an empty list for an empty prefix", async () => {
    sendMock.mockResolvedValueOnce({});

    expect(await listObjects("nothing/")).toEqual([]);
  });

  it("should drop entries missing a key, size or modification date", async () => {
    const d = new Date();
    sendMock.mockResolvedValueOnce({
      Contents: [
        { Key: "ok", Size: 0, LastModified: d },
        { Size: 1, LastModified: d },
        { Key: "no-size", LastModified: d },
        { Key: "no-date", Size: 1 },
      ],
    });

    expect(await listObjects("")).toEqual([{ key: "ok", size: 0, lastModified: d }]);
  });
});

describe("object writes", () => {
  it("should delete the given key from the app bucket", async () => {
    sendMock.mockResolvedValueOnce({});

    await deleteObject("downloads/EVT/x.zip");

    expect(sentCommand()).toBeInstanceOf(DeleteObjectCommand);
    expect(sentCommand().input).toEqual({ Bucket: BUCKET, Key: "downloads/EVT/x.zip" });
  });

  it("should put a buffer with its content type", async () => {
    sendMock.mockResolvedValueOnce({});
    const body = Buffer.from("x");

    await putObject("teachers/avatars/1.jpg", body, "image/jpeg");

    expect(sentCommand()).toBeInstanceOf(PutObjectCommand);
    expect(sentCommand().input).toEqual({
      Bucket: BUCKET,
      Key: "teachers/avatars/1.jpg",
      Body: body,
      ContentType: "image/jpeg",
    });
  });

  it("should URL-encode the copy source, including spaces and accents in the key", async () => {
    sendMock.mockResolvedValueOnce({});

    await copyObjectIntoAppBucket("legacy-bucket", "2019/Retiro Lisboa/001 Introdução.mp3", "events/EVT/001.mp3");

    expect(sentCommand()).toBeInstanceOf(CopyObjectCommand);
    expect(sentCommand().input).toEqual({
      Bucket: BUCKET,
      Key: "events/EVT/001.mp3",
      CopySource: encodeURIComponent("legacy-bucket/2019/Retiro Lisboa/001 Introdução.mp3"),
    });
  });

  it("should propagate a write failure", async () => {
    sendMock.mockRejectedValueOnce(new Error("AccessDenied"));

    await expect(deleteObject("k")).rejects.toThrow("AccessDenied");
  });
});

describe("uploadStream", () => {
  it("should run a multipart upload with 5 MB parts and 4 concurrent parts", async () => {
    uploadDoneMock.mockResolvedValueOnce({});
    const stream = Readable.from(Buffer.from("zip"));

    await uploadStream("downloads/EVT/x.zip", stream, "application/zip");

    expect(uploadCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { Bucket: BUCKET, Key: "downloads/EVT/x.zip", Body: stream, ContentType: "application/zip" },
        queueSize: 4,
        partSize: 5 * 1024 * 1024,
      }),
    );
    expect(uploadDoneMock).toHaveBeenCalledTimes(1);
  });

  it("should reject when the multipart upload fails", async () => {
    uploadDoneMock.mockRejectedValueOnce(new Error("part 3 failed"));

    await expect(
      uploadStream("downloads/EVT/x.zip", Readable.from(Buffer.from("zip")), "application/zip"),
    ).rejects.toThrow("part 3 failed");
  });
});
