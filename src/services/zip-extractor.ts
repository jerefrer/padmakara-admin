import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { config } from "../config.ts";

const lambdaClient = new LambdaClient({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

interface ExtractZipParams {
  sourceBucket: string;
  zipKey: string;
  targetPrefix: string;
}

export interface ExtractZipResult {
  extractedFiles: number;
  skippedFiles: number;
}

/**
 * Invoke the padmakara-zip-extractor Lambda to extract a ZIP from `sourceBucket`
 * into the app bucket under `targetPrefix`. Server-side and in-region — no
 * egress. Throws if the Lambda errors or reports `success: false`.
 */
export async function extractZip(
  params: ExtractZipParams,
): Promise<ExtractZipResult> {
  const payload = {
    zipUrl: params.zipKey,
    sourceBucket: params.sourceBucket,
    targetBucket: config.aws.s3Bucket,
    targetPrefix: params.targetPrefix,
  };

  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: config.importer.zipExtractorFn,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );

  if (response.FunctionError) {
    throw new Error(
      `zip-extractor Lambda error (${response.FunctionError}) for ${params.zipKey}`,
    );
  }

  // The Lambda returns { statusCode, body: JSON.stringify({...}) }.
  const envelope = JSON.parse(Buffer.from(response.Payload ?? []).toString());
  const body = JSON.parse(envelope.body ?? "{}");
  if (!body.success) {
    throw new Error(
      `zip-extractor failed for ${params.zipKey}: ${body.message ?? "unknown error"}`,
    );
  }

  return {
    extractedFiles: body.extractedFiles ?? 0,
    skippedFiles: body.skippedFiles ?? 0,
  };
}
