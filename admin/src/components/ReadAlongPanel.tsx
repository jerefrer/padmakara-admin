import { useCallback, useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Tooltip from "@mui/material/Tooltip";
import Divider from "@mui/material/Divider";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ReplayIcon from "@mui/icons-material/Replay";
import { useNotify, useRefresh, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";
import { friendlyJobError } from "../utils/friendlyJobError";

interface ReadAlongJob {
  id: string;
  status: string;
  batchJobId: string | null;
  language: string;
  skipPages: number;
  whisperModel: string;
  errorMessage: string | null;
  uploadedFiles: Record<string, string> | null;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
}

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

function statusColor(status: string): "default" | "info" | "warning" | "success" | "error" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "processing":
    case "submitted":
    case "running":
      return "info";
    case "pending":
    case "queued":
      return "warning";
    default:
      return "default";
  }
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

interface Props {
  eventId: number;
}

export const ReadAlongPanel = ({ eventId }: Props) => {
  const translate = useTranslate();
  const notify = useNotify();
  const refresh = useRefresh();

  const [jobs, setJobs] = useState<ReadAlongJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTerminalCount = useRef<number>(0);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await authFetch(`/api/admin/events/${eventId}/read-along`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { jobs: ReadAlongJob[] };
      setJobs(data.jobs ?? []);

      // If a job just transitioned to a terminal state, refresh the parent
      // event view so newly-set readAlongS3Key fields appear on tracks.
      const terminalCount = (data.jobs ?? []).filter((j) => TERMINAL_STATUSES.has(j.status)).length;
      if (terminalCount > lastTerminalCount.current) {
        refresh();
      }
      lastTerminalCount.current = terminalCount;
    } catch {
      // Silent — polling will retry; surfacing every error is noisy.
    } finally {
      setLoading(false);
    }
  }, [eventId, refresh]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Poll every 10s while any job is non-terminal.
  useEffect(() => {
    const hasActiveJob = jobs.some((j) => !TERMINAL_STATUSES.has(j.status));
    if (!hasActiveJob) {
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    pollTimer.current = setTimeout(fetchJobs, 10_000);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [jobs, fetchJobs]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await authFetch(`/api/admin/events/${eventId}/read-along`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        const msg = body.error?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      notify(translate("padmakara.readAlong.submittedSuccess"), { type: "success" });
      await fetchJobs();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`${translate("padmakara.readAlong.submitFailed")}: ${msg}`, { type: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  const latestJob = jobs[0] ?? null;
  const hasActive = jobs.some((j) => !TERMINAL_STATUSES.has(j.status));
  const isCompleted = !hasActive && latestJob?.status === "completed";
  const isFailed = !hasActive && latestJob?.status === "failed";
  // Fallback for "no job yet" and any unrecognized/unexpected status — shows
  // the prominent Generate button, same as the original always-on behavior.
  const showGenerateProminent = !hasActive && !isCompleted && !isFailed;

  return (
    <Paper sx={{ p: 3, mb: 2 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 0.5 }}>
        <GraphicEqIcon color="primary" />
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          {translate("padmakara.readAlong.title")}
        </Typography>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {translate("padmakara.readAlong.description")}
      </Typography>

      {loading ? (
        <Typography variant="body2" color="text.secondary">
          {translate("ra.page.loading")}
        </Typography>
      ) : hasActive && latestJob ? (
        <Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <Chip
              label={translate(`padmakara.readAlong.status.${latestJob.status}`, { _: latestJob.status })}
              size="small"
              color={statusColor(latestJob.status)}
            />
            <Typography variant="body2" color="text.secondary">
              {translate("padmakara.readAlong.lastJob", {
                language: latestJob.language.toUpperCase(),
                when: formatTimestamp(latestJob.completedAt ?? latestJob.submittedAt ?? latestJob.createdAt),
              })}
            </Typography>
          </Box>
          <LinearProgress sx={{ mt: 2, borderRadius: 1 }} />
        </Box>
      ) : isCompleted && latestJob ? (
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, flexWrap: "wrap" }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <CheckCircleIcon color="success" fontSize="small" />
            <Typography variant="body2">
              {translate("padmakara.readAlong.readyStatus", {
                language: latestJob.language.toUpperCase(),
                when: formatTimestamp(latestJob.completedAt ?? latestJob.submittedAt ?? latestJob.createdAt),
              })}
            </Typography>
          </Box>
          <Box sx={{ textAlign: "right" }}>
            <Tooltip title={translate("padmakara.readAlong.generateTooltip")}>
              <span>
                <Button
                  variant="text"
                  size="small"
                  startIcon={<ReplayIcon fontSize="small" />}
                  onClick={handleSubmit}
                  disabled={submitting || hasActive}
                >
                  {submitting
                    ? translate("padmakara.readAlong.generating")
                    : translate("padmakara.readAlong.regenerate")}
                </Button>
              </span>
            </Tooltip>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              {translate("padmakara.readAlong.regenerateHint")}
            </Typography>
          </Box>
        </Box>
      ) : isFailed && latestJob ? (
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, flexWrap: "wrap" }}>
          <Tooltip title={latestJob.errorMessage ?? ""}>
            <Typography
              variant="body2"
              color="error"
              sx={{ cursor: latestJob.errorMessage ? "help" : undefined }}
            >
              {friendlyJobError(latestJob.errorMessage, translate)}
            </Typography>
          </Tooltip>
          <Button
            variant="contained"
            color="error"
            startIcon={<ReplayIcon />}
            onClick={handleSubmit}
            disabled={submitting || hasActive}
          >
            {submitting ? translate("padmakara.readAlong.generating") : translate("padmakara.readAlong.retry")}
          </Button>
        </Box>
      ) : (
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, flexWrap: "wrap" }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, minHeight: 32 }}>
            {latestJob ? (
              <>
                <Chip
                  label={translate(`padmakara.readAlong.status.${latestJob.status}`, { _: latestJob.status })}
                  size="small"
                  color={statusColor(latestJob.status)}
                />
                <Typography variant="body2" color="text.secondary">
                  {translate("padmakara.readAlong.lastJob", {
                    language: latestJob.language.toUpperCase(),
                    when: formatTimestamp(latestJob.completedAt ?? latestJob.submittedAt ?? latestJob.createdAt),
                  })}
                </Typography>
              </>
            ) : (
              <Typography variant="body2" color="text.secondary">
                {translate("padmakara.readAlong.noJobs")}
              </Typography>
            )}
          </Box>

          <Tooltip title={translate("padmakara.readAlong.generateTooltip")}>
            <span>
              <Button
                variant="contained"
                startIcon={<GraphicEqIcon />}
                onClick={handleSubmit}
                disabled={submitting || hasActive}
              >
                {submitting
                  ? translate("padmakara.readAlong.generating")
                  : translate("padmakara.readAlong.generate")}
              </Button>
            </span>
          </Tooltip>
        </Box>
      )}

      {jobs.length > 1 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
            {translate("padmakara.readAlong.recentJobs")}
          </Typography>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
            {jobs.slice(1, 5).map((job) => (
              <Box
                key={job.id}
                sx={{ display: "flex", alignItems: "center", gap: 1.5, fontSize: "0.8125rem" }}
              >
                <Chip
                  label={translate(`padmakara.readAlong.status.${job.status}`, { _: job.status })}
                  size="small"
                  color={statusColor(job.status)}
                  sx={{ minWidth: 90 }}
                />
                <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                  {job.language.toUpperCase()} · {formatTimestamp(job.completedAt ?? job.submittedAt ?? job.createdAt)}
                </Typography>
                {job.errorMessage && (
                  <Tooltip title={friendlyJobError(job.errorMessage, translate)}>
                    <Typography variant="caption" color="error" sx={{ cursor: "help" }}>
                      ⚠
                    </Typography>
                  </Tooltip>
                )}
              </Box>
            ))}
          </Box>
        </>
      )}
    </Paper>
  );
};
