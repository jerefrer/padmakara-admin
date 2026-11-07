import { useState, type MouseEvent } from "react";
import { useTranslate } from "react-admin";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Popover from "@mui/material/Popover";
import Typography from "@mui/material/Typography";
import { authFetch } from "../utils/authFetch";
import {
  formatBitrate,
  formatBytes,
  formatDurationHms,
  formatFrameRate,
  formatResolution,
  formatSampleRate,
} from "../utils/fileInfo";

interface TrackFileInfo {
  originalFilename: string | null;
  sizeBytes: number | null;
  format: string | null;
  durationSeconds: number | null;
  bitrateKbps: number | null;
  sampleRateHz: number | null;
  channels: number | null;
}

interface VideoFileInfo {
  originalFilename: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  framerate: number | null;
}

interface Props {
  kind: "track" | "video";
  id: number;
}

/**
 * Subtle "i" icon that opens a popover with the details of the stored file
 * (original name, size, format, bit rate / resolution…). Fetches on open.
 */
export function FileInfoButton({ kind, id }: Props) {
  const translate = useTranslate();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [data, setData] = useState<TrackFileInfo | VideoFileInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const t = (key: string, fallback: string, opts?: Record<string, unknown>) =>
    translate(`padmakara.fileInfo.${key}`, { _: fallback, ...opts });

  const load = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const res = await authFetch(`/api/admin/${kind === "track" ? "tracks" : "videos"}/${id}/file-info`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setAnchor(e.currentTarget);
    void load();
  };

  const channelsLabel = (n: number | null): string | null => {
    if (n == null) return null;
    if (n === 1) return t("mono", "Mono");
    if (n === 2) return t("stereo", "Stereo");
    return t("channelsCount", `${n} channels`, { count: n });
  };

  const rows: Array<[string, string | null]> = [];
  if (data) {
    rows.push(
      [t("originalName", "Original file name"), data.originalFilename],
      [t("size", "Size"), formatBytes(data.sizeBytes)],
    );
    if (kind === "track") {
      const d = data as TrackFileInfo;
      rows.push(
        [t("format", "Format"), d.format],
        [t("duration", "Duration"), formatDurationHms(d.durationSeconds)],
        [t("bitrate", "Bit rate"), formatBitrate(d.bitrateKbps)],
        [t("sampleRate", "Sample rate"), formatSampleRate(d.sampleRateHz)],
        [t("channels", "Channels"), channelsLabel(d.channels)],
      );
    } else {
      const d = data as VideoFileInfo;
      rows.push(
        [t("duration", "Duration"), formatDurationHms(d.durationSeconds)],
        [t("resolution", "Resolution"), formatResolution(d.width, d.height)],
        [t("frameRate", "Frame rate"), formatFrameRate(d.framerate)],
      );
    }
  }

  return (
    <>
      <IconButton
        size="small"
        onClick={handleOpen}
        aria-label={t("title", "File details")}
        title={t("title", "File details")}
        sx={{ opacity: 0.5, "&:hover": { opacity: 1 } }}
      >
        <InfoOutlinedIcon sx={{ fontSize: 16 }} />
      </IconButton>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        onClick={(e) => e.stopPropagation()}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <Box sx={{ p: 2, minWidth: 260, maxWidth: 380 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            {t("title", "File details")}
          </Typography>
          {loading && <CircularProgress size={18} />}
          {failed && (
            <Typography variant="body2" color="error">
              {t("error", "Could not load the file details")}
            </Typography>
          )}
          {!loading &&
            !failed &&
            rows.map(([label, value]) => (
              <Box key={label} sx={{ display: "flex", gap: 2, py: 0.25 }}>
                <Typography variant="caption" color="text.secondary" sx={{ width: 120, flexShrink: 0 }}>
                  {label}
                </Typography>
                <Typography variant="caption" sx={{ wordBreak: "break-all" }}>
                  {value ?? "—"}
                </Typography>
              </Box>
            ))}
        </Box>
      </Popover>
    </>
  );
}
