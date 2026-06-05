import { config } from "../config.ts";

const BASE = "https://video.bunnycdn.com";

export function captionUploadBody(srclang: string, label: string, vtt: string) {
  return { srclang, label, captionsFile: Buffer.from(vtt, "utf-8").toString("base64") };
}

/** Upload (POST replaces an existing srclang) a caption track on a Bunny video. */
export async function addCaption(
  videoId: string,
  srclang: string,
  label: string,
  vtt: string,
): Promise<void> {
  const url = `${BASE}/library/${config.bunny.libraryId}/videos/${videoId}/captions/${srclang}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      AccessKey: config.bunny.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(captionUploadBody(srclang, label, vtt)),
  });
  if (!res.ok) throw new Error(`Bunny addCaption ${res.status}: ${await res.text()}`);
}

export async function deleteCaption(videoId: string, srclang: string): Promise<void> {
  const url = `${BASE}/library/${config.bunny.libraryId}/videos/${videoId}/captions/${srclang}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: { AccessKey: config.bunny.apiKey },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Bunny deleteCaption ${res.status}`);
  }
}

export async function listCaptions(
  videoId: string,
): Promise<Array<{ srclang: string; label: string }>> {
  const url = `${BASE}/library/${config.bunny.libraryId}/videos/${videoId}`;
  const res = await fetch(url, {
    headers: { AccessKey: config.bunny.apiKey },
  });
  if (!res.ok) throw new Error(`Bunny getVideo ${res.status}`);
  const data = (await res.json()) as { captions?: Array<{ srclang: string; label: string }> };
  return data.captions ?? [];
}
