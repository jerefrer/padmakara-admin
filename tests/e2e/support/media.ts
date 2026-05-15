/**
 * Fixture media uploader for the e2e test suite.
 *
 * Uploads tiny placeholder buffers to MinIO for every track and transcript S3
 * key in the seeded dataset. The API e2e tests only need these objects to
 * EXIST and be fetchable as presigned URLs — they do not decode audio or render
 * PDFs, so a placeholder buffer is sufficient.
 *
 * S3 key scheme (must match seed.ts):
 *   tracks      → events/<eventCode>/track-{1,2}.mp3
 *   transcripts → events/<eventCode>/transcripts/transcript.pdf
 */

import { putObject } from "../../../src/services/s3.ts";
import { EVENT_CODES } from "./fixtures.ts";

const PLACEHOLDER = Buffer.from("e2e-fixture-placeholder");

/**
 * Upload one placeholder object per track and transcript in the seeded dataset.
 *
 * Must be called after:
 *  1. MinIO is running and the test bucket exists.
 *  2. `seedTestData()` has inserted the corresponding DB rows (so the S3 keys
 *     match what the API will read from the database).
 */
export async function uploadFixtureMedia(): Promise<void> {
  const eventCodes = Object.values(EVENT_CODES) as string[];

  const uploads: Promise<void>[] = [];

  for (const code of eventCodes) {
    // Track 1
    uploads.push(
      putObject(`events/${code}/track-1.mp3`, PLACEHOLDER, "audio/mpeg"),
    );
    // Track 2
    uploads.push(
      putObject(`events/${code}/track-2.mp3`, PLACEHOLDER, "audio/mpeg"),
    );
    // Transcript PDF
    uploads.push(
      putObject(
        `events/${code}/transcripts/transcript.pdf`,
        PLACEHOLDER,
        "application/pdf",
      ),
    );
  }

  await Promise.all(uploads);
}
