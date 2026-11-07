/** Display helpers for the file-details popover. Unknown values give null. */

export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** h:mm:ss; null for unknown or zero (an unparsed duration is stored as 0). */
export function formatDurationHms(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatBitrate(kbps: number | null | undefined): string | null {
  return kbps == null ? null : `${kbps} kbps`;
}

export function formatSampleRate(hz: number | null | undefined): string | null {
  if (hz == null) return null;
  return `${Number((hz / 1000).toFixed(1))} kHz`;
}

export function formatResolution(
  width: number | null | undefined,
  height: number | null | undefined,
): string | null {
  return width && height ? `${width} × ${height}` : null;
}

export function formatFrameRate(fps: number | null | undefined): string | null {
  return fps == null ? null : `${Number(fps.toFixed(2))} fps`;
}
