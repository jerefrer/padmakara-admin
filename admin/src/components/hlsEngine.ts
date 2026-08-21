/** Playback engine for an HLS source in the admin preview player. */
export type VideoEngine = "hlsjs" | "native" | "direct";

/**
 * Choose the playback engine for an HLS `.m3u8` source.
 *
 * hls.js (MSE) is preferred wherever it works — every Chromium and Firefox —
 * and native HLS is used ONLY when hls.js cannot run (Safari/iOS). This
 * precedence matters: some Chromium builds report
 * `canPlayType('application/vnd.apple.mpegurl')` as `"maybe"` yet cannot
 * actually decode a raw `.m3u8` assigned to `video.src` — it fails with
 * `MediaError` code 4 (SRC_NOT_SUPPORTED). So native "support" must never take
 * precedence over hls.js; checking native first is the bug this guards against.
 */
export function chooseVideoEngine(opts: {
  hlsjsSupported: boolean;
  nativeHls: boolean;
}): VideoEngine {
  if (opts.hlsjsSupported) return "hlsjs";
  if (opts.nativeHls) return "native";
  return "direct";
}
