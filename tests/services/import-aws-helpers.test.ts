import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted ensures these are available when the mock factories below run
// (vi.mock calls are hoisted to the top of the file by Vitest).
const { mockLambdaSend, mockS3Send } = vi.hoisted(() => ({
  mockLambdaSend: vi.fn(),
  mockS3Send: vi.fn(),
}));

// --- mock the Lambda SDK ---
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: function MockLambdaClient() {
    return { send: mockLambdaSend };
  },
  InvokeCommand: function MockInvokeCommand(input: unknown) {
    return { input };
  },
}));

// --- mock the S3 SDK, keeping the command classes real ---
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: function MockS3Client() {
      return { send: mockS3Send };
    },
  };
});

import { extractZip } from "../../src/services/zip-extractor.ts";
import { copyObjectIntoAppBucket } from "../../src/services/s3.ts";

function lambdaPayload(body: unknown) {
  return {
    Payload: Buffer.from(
      JSON.stringify({ statusCode: 200, body: JSON.stringify(body) }),
    ),
  };
}

describe("extractZip", () => {
  beforeEach(() => mockLambdaSend.mockReset());

  it("invokes the Lambda and returns the extracted counts", async () => {
    mockLambdaSend.mockResolvedValue(
      lambdaPayload({ success: true, extractedFiles: 5, skippedFiles: 1 }),
    );
    const result = await extractZip({
      sourceBucket: "padmakara-pt",
      zipKey: "mediateca/EV/a.zip",
      targetPrefix: "events/EV",
    });
    expect(result).toEqual({ extractedFiles: 5, skippedFiles: 1 });

    const sent = mockLambdaSend.mock.calls[0]?.[0] as { input: { Payload: Buffer } };
    const payload = JSON.parse(sent.input.Payload.toString());
    expect(payload).toMatchObject({
      zipUrl: "mediateca/EV/a.zip",
      sourceBucket: "padmakara-pt",
      targetPrefix: "events/EV",
    });
  });

  it("throws when the Lambda reports success: false", async () => {
    mockLambdaSend.mockResolvedValue(
      lambdaPayload({ success: false, message: "bad zip" }),
    );
    await expect(
      extractZip({ sourceBucket: "padmakara-pt", zipKey: "x.zip", targetPrefix: "events/EV" }),
    ).rejects.toThrow(/bad zip/);
  });

  it("throws when the Lambda invocation itself errored", async () => {
    mockLambdaSend.mockResolvedValue({ FunctionError: "Unhandled", Payload: Buffer.from("{}") });
    await expect(
      extractZip({ sourceBucket: "padmakara-pt", zipKey: "x.zip", targetPrefix: "events/EV" }),
    ).rejects.toThrow(/zip-extractor/i);
  });
});

describe("copyObjectIntoAppBucket", () => {
  beforeEach(() => mockS3Send.mockReset());

  it("sends a CopyObjectCommand with an encoded cross-bucket CopySource", async () => {
    mockS3Send.mockResolvedValue({});
    await copyObjectIntoAppBucket(
      "padmakara-pt",
      "mediateca/EV/Audio 1/t.mp3",
      "events/EV/t.mp3",
    );
    const cmd = mockS3Send.mock.calls[0]?.[0] as { input: Record<string, string> };
    expect(cmd.input.Key).toBe("events/EV/t.mp3");
    expect(cmd.input.CopySource).toBe(
      encodeURIComponent("padmakara-pt/mediateca/EV/Audio 1/t.mp3"),
    );
    expect(cmd.input.Bucket).toBeDefined();
  });
});
