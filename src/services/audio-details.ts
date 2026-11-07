import { parseBuffer } from "music-metadata";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { tracks } from "../db/schema/tracks.ts";
import { generatePresignedDownloadUrl } from "./s3.ts";

/** Bytes fetched per file: enough for MP3 headers and the Xing/VBRI frame. */
export const AUDIO_HEAD_BYTES = 512 * 1024;

export interface AudioDetails {
  bitrateKbps: number | null;
  sampleRateHz: number | null;
  channels: number | null;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
};

/**
 * Resolves a MIME type, a bare/dotted extension or a file name/path to a
 * MIME type music-metadata understands. Undefined when unknown.
 */
export function mimeFromExtension(mimeOrExt: string): string | undefined {
  if (mimeOrExt.startsWith("audio/")) return mimeOrExt;
  const ext = mimeOrExt.includes(".")
    ? mimeOrExt.slice(mimeOrExt.lastIndexOf(".") + 1)
    : mimeOrExt;
  return MIME_BY_EXTENSION[ext.toLowerCase()];
}

const positiveInt = (n: number | undefined): number | null =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;

/**
 * Reads bit rate, sample rate and channel count from the first bytes of an
 * audio file. Best effort: returns null when nothing could be read (never
 * throws), so callers can treat details as optional.
 */
export async function readAudioDetails(
  buffer: Uint8Array,
  mimeOrExt: string,
): Promise<AudioDetails | null> {
  if (buffer.byteLength === 0) return null;
  try {
    const { format } = await parseBuffer(
      buffer,
      { mimeType: mimeFromExtension(mimeOrExt) },
      { skipCovers: true },
    );
    const bitrate = positiveInt(format.bitrate);
    const details: AudioDetails = {
      bitrateKbps: bitrate === null ? null : Math.round(bitrate / 1000),
      sampleRateHz: positiveInt(format.sampleRate),
      channels: positiveInt(format.numberOfChannels),
    };
    return details.bitrateKbps === null &&
      details.sampleRateHz === null &&
      details.channels === null
      ? null
      : details;
  } catch {
    return null;
  }
}

/** One-line summary for logs, e.g. "128 kbps, 44100 Hz, 2 ch" ("?" when unknown). */
export function describeAudioDetails(d: AudioDetails): string {
  return [
    d.bitrateKbps === null ? "? kbps" : `${d.bitrateKbps} kbps`,
    d.sampleRateHz === null ? "? Hz" : `${d.sampleRateHz} Hz`,
    d.channels === null ? "? ch" : `${d.channels} ch`,
  ].join(", ");
}

/** Fetches the first AUDIO_HEAD_BYTES of an S3 object with a Range request. */
export async function fetchAudioHead(
  s3Key: string,
  presign: (key: string, expiresIn: number) => Promise<string> = generatePresignedDownloadUrl,
): Promise<Uint8Array | null> {
  const url = await presign(s3Key, 300);
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${AUDIO_HEAD_BYTES - 1}` },
  });
  if (!response.ok && response.status !== 206) return null;
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Reads a track's audio details from S3 and stores them. Best effort: any
 * failure (S3, parsing, DB) is logged and swallowed so an upload never fails
 * because of it.
 */
export async function recordTrackAudioDetails(trackId: number, s3Key: string): Promise<void> {
  try {
    const head = await fetchAudioHead(s3Key);
    if (!head) return;
    const details = await readAudioDetails(head, s3Key);
    if (!details) return;
    await db
      .update(tracks)
      .set({
        bitrateKbps: details.bitrateKbps,
        sampleRateHz: details.sampleRateHz,
        channels: details.channels,
      })
      .where(eq(tracks.id, trackId));
  } catch (err) {
    console.error(`[audio-details] track ${trackId}:`, err);
  }
}
