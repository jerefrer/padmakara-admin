import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseDriveFileId,
  resolveVideoSourceUrl,
  validateDriveFile,
} from "../../src/services/drive-url.ts";

const ID = "1AbC-dEf_9xYz1234567890abcdefghijklm";

describe("parseDriveFileId", () => {
  it("extracts the id from a /file/d/{id}/view share link", () => {
    expect(parseDriveFileId(`https://drive.google.com/file/d/${ID}/view?usp=sharing`)).toBe(ID);
  });

  it("extracts the id from a /file/d/{id} link without a suffix", () => {
    expect(parseDriveFileId(`https://drive.google.com/file/d/${ID}`)).toBe(ID);
  });

  it("extracts the id from an open?id= link", () => {
    expect(parseDriveFileId(`https://drive.google.com/open?id=${ID}`)).toBe(ID);
  });

  it("extracts the id from a uc?export=download&id= link", () => {
    expect(parseDriveFileId(`https://drive.google.com/uc?export=download&id=${ID}`)).toBe(ID);
  });

  it("extracts the id from a docs.google.com/uc link", () => {
    expect(parseDriveFileId(`https://docs.google.com/uc?id=${ID}`)).toBe(ID);
  });

  it("extracts the id from a drive.usercontent.google.com download link", () => {
    expect(
      parseDriveFileId(`https://drive.usercontent.google.com/download?id=${ID}&export=download`),
    ).toBe(ID);
  });

  it("returns null for non-Drive URLs", () => {
    expect(parseDriveFileId("https://example.com/video.mp4")).toBeNull();
  });

  it("returns null for a Drive folder link", () => {
    expect(parseDriveFileId(`https://drive.google.com/drive/folders/${ID}`)).toBeNull();
  });
});

describe("resolveVideoSourceUrl", () => {
  it("passes non-Drive https URLs through unchanged", () => {
    const resolved = resolveVideoSourceUrl("https://example.com/videos/talk.mp4", "");
    expect(resolved.sourceUrl).toBe("https://example.com/videos/talk.mp4");
    expect(resolved.driveFileId).toBeNull();
  });

  it("rewrites a Drive share link to the usercontent download URL when no API key is set", () => {
    const resolved = resolveVideoSourceUrl(`https://drive.google.com/file/d/${ID}/view`, "");
    expect(resolved.driveFileId).toBe(ID);
    expect(resolved.sourceUrl).toBe(
      `https://drive.usercontent.google.com/download?id=${ID}&export=download&confirm=t`,
    );
  });

  it("rewrites a Drive share link to the Drive API media URL when an API key is set", () => {
    const resolved = resolveVideoSourceUrl(`https://drive.google.com/file/d/${ID}/view`, "my-key");
    expect(resolved.driveFileId).toBe(ID);
    expect(resolved.sourceUrl).toBe(
      `https://www.googleapis.com/drive/v3/files/${ID}?alt=media&key=my-key`,
    );
  });

  it("rejects non-http(s) URLs", () => {
    expect(() => resolveVideoSourceUrl("ftp://example.com/video.mp4", "")).toThrow(/URL/i);
  });

  it("rejects strings that are not URLs at all", () => {
    expect(() => resolveVideoSourceUrl("not a url", "")).toThrow(/URL/i);
  });

  it("rejects Drive folder links with a clear message", () => {
    expect(() =>
      resolveVideoSourceUrl(`https://drive.google.com/drive/folders/${ID}`, ""),
    ).toThrow(/folder/i);
  });
});

describe("validateDriveFile", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns file metadata for a public file", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ name: "talk.mp4", mimeType: "video/mp4", size: "1048576" }),
    });

    const meta = await validateDriveFile(ID, "my-key");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `https://www.googleapis.com/drive/v3/files/${ID}?fields=name,mimeType,size&key=my-key`,
    );
    expect(meta).toEqual({ name: "talk.mp4", mimeType: "video/mp4", size: 1048576 });
  });

  it("throws a not-found error for a 404 response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    });

    await expect(validateDriveFile(ID, "my-key")).rejects.toThrow(/anyone with the link/i);
  });

  it("throws a sharing error for a 403 response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });

    await expect(validateDriveFile(ID, "my-key")).rejects.toThrow(/anyone with the link/i);
  });

  it("rejects Google-native documents (non-downloadable)", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ name: "Doc", mimeType: "application/vnd.google-apps.document" }),
    });

    await expect(validateDriveFile(ID, "my-key")).rejects.toThrow(/not a downloadable file/i);
  });
});
