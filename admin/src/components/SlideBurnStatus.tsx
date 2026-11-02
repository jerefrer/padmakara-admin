/**
 * Burn pipeline status for a video: the row chip and the "start / retry the
 * burn" action. Shared by the video list and the slide editor.
 */

import ReplayIcon from "@mui/icons-material/Replay";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import { useTranslate } from "react-admin";

type Translate = ReturnType<typeof useTranslate>;

/* ───────── Burn action: start / retry the burn from the retained master ───────── */

interface BurnActionButtonProps {
  hasMaster: boolean;
  slideCount: number;
  burnStatus: string | null;
  reburning: boolean;
  onReburn: () => void | Promise<unknown>;
}

/** Shown only when a burn can actually be started: a retained master, at
 *  least one slide, and a burn that failed or went stale after a slide edit. */
export const BurnActionButton = ({ hasMaster, slideCount, burnStatus, reburning, onReburn }: BurnActionButtonProps) => {
  const translate = useTranslate();
  if (!hasMaster || slideCount <= 0) return null;
  if (burnStatus !== "failed" && burnStatus !== "pending") return null;
  const label =
    burnStatus === "failed"
      ? translate("padmakara.slides.retryBurn", { _: "Retry" })
      : translate("padmakara.slides.startBurn", { _: "Burn slides" });
  return (
    <Button
      size="small"
      disabled={reburning}
      onClick={() => void onReburn()}
      startIcon={reburning ? <CircularProgress size={12} thickness={5} color="inherit" /> : <ReplayIcon sx={{ fontSize: 15 }} />}
      sx={{ color: "#b91c1c", fontWeight: 700, fontSize: "0.7rem", textTransform: "none", minWidth: 0, py: 0 }}
    >
      {label}
    </Button>
  );
};

/* ───────── Row chip: at-a-glance burn pipeline status ───────── */

const BURN_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: "rgba(0,0,0,0.05)", text: "text.secondary" },
  queued: { bg: "#fdf2f2", text: "#9b1b1b" },
  running: { bg: "#fffbeb", text: "#b45309" },
  done: { bg: "#f0fdf4", text: "#15803d" },
  failed: { bg: "#fef2f2", text: "#b91c1c" },
};

/** Disk evidence reported by the last burn container run. */
export interface BurnDisk {
  masterBytes: number | null;
  peakBytes: number | null;
}

const formatGB = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/** "Master 16.3 GB · peak disk 33.1 GB", or null when nothing was measured. */
export function burnDiskLine(disk: BurnDisk | null | undefined, translate: Translate): string | null {
  if (!disk) return null;
  const parts: string[] = [];
  if (disk.masterBytes != null) {
    parts.push(`${translate("padmakara.slides.burnDisk.master") || "Master"} ${formatGB(disk.masterBytes)}`);
  }
  if (disk.peakBytes != null) {
    parts.push(`${translate("padmakara.slides.burnDisk.peak") || "peak disk"} ${formatGB(disk.peakBytes)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

interface BurnStatusChipProps {
  status: string | null;
  error: string | null;
  disk?: BurnDisk | null;
}

/** Renders nothing for "none" (the DB default — no burn pipeline activity
 *  yet, e.g. a video with no slides or one flagged "already has slides
 *  burnt in") so old/unaffected rows look exactly as before. */
export const BurnStatusChip = ({ status, error, disk }: BurnStatusChipProps) => {
  const translate = useTranslate();
  if (!status || status === "none") return null;
  const colors = BURN_STATUS_COLORS[status] ?? BURN_STATUS_COLORS.pending;
  const label = translate(`padmakara.slides.burnStatus.${status}`, { _: status }) || status;

  const chip = (
    <Chip
      label={label}
      size="small"
      icon={status === "running" ? <CircularProgress size={10} thickness={5} sx={{ color: `${colors.text} !important` }} /> : undefined}
      sx={{
        height: 20,
        fontWeight: 700,
        backgroundColor: colors.bg,
        color: colors.text,
        "& .MuiChip-label": { px: 0.7, fontSize: "0.65rem", letterSpacing: "0.02em" },
        "& .MuiChip-icon": { ml: 0.6, mr: -0.2 },
      }}
    />
  );

  const diskLine = burnDiskLine(disk, translate);
  const showError = status === "failed" && !!error;
  if (!showError && !diskLine) return chip;
  return (
    <Tooltip
      title={
        <>
          {showError && <div>{error}</div>}
          {diskLine && <div style={{ opacity: 0.7, fontSize: "0.7rem" }}>{diskLine}</div>}
        </>
      }
    >
      {chip}
    </Tooltip>
  );
};
