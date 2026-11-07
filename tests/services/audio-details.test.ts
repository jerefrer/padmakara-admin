import { describe, it, expect } from "vitest";
import { readAudioDetails, mimeFromExtension, describeAudioDetails } from "../../src/services/audio-details.ts";

/** Minimal PCM WAV: 8 kHz, mono, 16-bit, 100 samples. */
function buildWav(sampleRate: number, channels: number, samples = 100): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = samples * channels * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bytesPerSample, true);
  v.setUint16(32, channels * bytesPerSample, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, dataSize, true);
  return new Uint8Array(buf);
}

/** A few silent MPEG-1 Layer III frames: 128 kbps, 44.1 kHz, joint stereo (417 bytes each). */
function buildMp3(frames = 6): Uint8Array {
  const out = new Uint8Array(417 * frames);
  for (let i = 0; i < frames; i++) out.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  return out;
}

describe("readAudioDetails", () => {
  it("should read sample rate, channels and bit rate from a WAV header", async () => {
    const details = await readAudioDetails(buildWav(8000, 1), "wav");
    expect(details).toEqual({ bitrateKbps: 128, sampleRateHz: 8000, channels: 1 });
  });

  it("should read 128 kbps, 44.1 kHz and stereo from MP3 frames", async () => {
    const details = await readAudioDetails(buildMp3(), "audio/mpeg");
    expect(details).toEqual({ bitrateKbps: 128, sampleRateHz: 44100, channels: 2 });
  });

  it("should accept a file name or dotted extension as type hint", async () => {
    expect(await readAudioDetails(buildMp3(), "01 - Talk.MP3")).not.toBeNull();
    expect(await readAudioDetails(buildMp3(), ".mp3")).not.toBeNull();
  });

  it("should return null when the bytes are not audio", async () => {
    const junk = new Uint8Array(2048).fill(7);
    expect(await readAudioDetails(junk, "mp3")).toBeNull();
  });

  it("should return null for an empty buffer", async () => {
    expect(await readAudioDetails(new Uint8Array(0), "mp3")).toBeNull();
  });
});

describe("mimeFromExtension", () => {
  it("should map common audio extensions and pass mime types through", () => {
    expect(mimeFromExtension("mp3")).toBe("audio/mpeg");
    expect(mimeFromExtension("a/b/c.m4a")).toBe("audio/mp4");
    expect(mimeFromExtension("audio/ogg")).toBe("audio/ogg");
    expect(mimeFromExtension("xyz")).toBeUndefined();
  });
});

describe("describeAudioDetails", () => {
  it("should summarize known values and mark unknown ones", () => {
    expect(describeAudioDetails({ bitrateKbps: 128, sampleRateHz: 44100, channels: 2 })).toBe(
      "128 kbps, 44100 Hz, 2 ch",
    );
    expect(describeAudioDetails({ bitrateKbps: null, sampleRateHz: 8000, channels: null })).toBe(
      "? kbps, 8000 Hz, ? ch",
    );
  });
});
