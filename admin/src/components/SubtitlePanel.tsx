import { useCallback, useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Tooltip from "@mui/material/Tooltip";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import ClosedCaptionIcon from "@mui/icons-material/ClosedCaption";
import DownloadIcon from "@mui/icons-material/Download";
import TranslateIcon from "@mui/icons-material/Translate";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { useNotify, useRefresh, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";

interface SubtitleJob {
  id: string;
  status: string;
  batchJobId: string | null;
  language: string;
  whisperModel: string;
  errorMessage: string | null;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
}

interface SessionSubtitle {
  id: number;
  sessionId: number;
  language: string;
  label: string;
  s3Key: string;
  origin: string;
  source: string;
  stale: boolean;
  bunnyUploadedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TranslationModel {
  id: string;
  label: string;
}

interface ModelsData {
  models: TranslationModel[];
  default: string;
}

const TERMINAL_STATUSES = new Set(["completed", "failed"]);
const TARGET_LANGS = ["pt", "es", "fr"] as const;
type TargetLang = (typeof TARGET_LANGS)[number];

const LANG_NAMES: Record<TargetLang, string> = {
  pt: "Portuguese",
  es: "Spanish",
  fr: "French",
};

function statusColor(status: string): "default" | "info" | "warning" | "success" | "error" {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "processing":
    case "submitted":
      return "info";
    case "pending":
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
  sessionVideoId: number;
  videoLabel?: string;
}

export const SubtitlePanel = ({ sessionVideoId, videoLabel }: Props) => {
  const translate = useTranslate();
  const notify = useNotify();
  const refresh = useRefresh();

  const [jobs, setJobs] = useState<SubtitleJob[]>([]);
  const [subtitles, setSubtitles] = useState<SessionSubtitle[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [downloadingLang, setDownloadingLang] = useState<string | null>(null);
  const [translatingLang, setTranslatingLang] = useState<string | null>(null);
  const [replacingLang, setReplacingLang] = useState<string | null>(null);

  // Translation model state
  const [modelsData, setModelsData] = useState<ModelsData | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTerminalCount = useRef<number>(0);

  // Load available translation models once on mount.
  useEffect(() => {
    authFetch("/api/admin/translation-models")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (
          data &&
          typeof data === "object" &&
          "models" in data &&
          "default" in data
        ) {
          const typed = data as ModelsData;
          setModelsData(typed);
          setSelectedModel(typed.default);
        }
      })
      .catch(() => {
        // Non-critical — user can still use default model.
      });
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await authFetch(`/api/admin/session-videos/${sessionVideoId}/subtitles`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { jobs: SubtitleJob[]; subtitles: SessionSubtitle[] };
      setJobs(data.jobs ?? []);
      setSubtitles(data.subtitles ?? []);

      // If a job just transitioned to a terminal state, refresh the parent view
      // so newly-generated subtitle tracks appear.
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
  }, [sessionVideoId, refresh]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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
    pollTimer.current = setTimeout(fetchData, 10_000);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [jobs, fetchData]);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await authFetch(`/api/admin/session-videos/${sessionVideoId}/subtitles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        const msg = body.error?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      notify(translate("padmakara.subtitles.submittedSuccess"), { type: "success" });
      await fetchData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`${translate("padmakara.subtitles.submitFailed")}: ${msg}`, { type: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDownload = async (lang: string) => {
    setDownloadingLang(lang);
    try {
      const res = await authFetch(`/api/admin/session-videos/${sessionVideoId}/subtitles/${lang}/download`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const blob = new Blob([text], { type: "text/vtt" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${lang}.vtt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`Download failed: ${msg}`, { type: "error" });
    } finally {
      setDownloadingLang(null);
    }
  };

  const handleTranslate = async (lang: TargetLang) => {
    setTranslatingLang(lang);
    try {
      const res = await authFetch(
        `/api/admin/session-videos/${sessionVideoId}/subtitles/${lang}/translate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: selectedModel }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        const msg = body.error?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      notify(
        translate("padmakara.subtitles.submittedSuccess"),
        { type: "success" },
      );
      await fetchData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`${translate("padmakara.subtitles.submitFailed")}: ${msg}`, { type: "error" });
    } finally {
      setTranslatingLang(null);
    }
  };

  const handleReplace = async (lang: string, file: File) => {
    setReplacingLang(lang);
    try {
      const text = await file.text();
      if (!text.startsWith("WEBVTT")) {
        notify("Not a WebVTT file", { type: "error" });
        return;
      }
      const res = await authFetch(
        `/api/admin/session-videos/${sessionVideoId}/subtitles/${lang}`,
        {
          method: "PUT",
          headers: { "Content-Type": "text/vtt" },
          body: text,
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      notify(translate("padmakara.subtitles.submittedSuccess"), { type: "success" });
      await fetchData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`Replace failed: ${msg}`, { type: "error" });
    } finally {
      setReplacingLang(null);
    }
  };

  const latestJob = jobs[0] ?? null;
  const hasActive = jobs.some((j) => !TERMINAL_STATUSES.has(j.status));
  const hasEnSource = subtitles.some((s) => s.language === "en");

  // For each target lang: is there an in-flight job right now?
  const isLangInFlight = (lang: string): boolean =>
    jobs.some((j) => j.language === lang && !TERMINAL_STATUSES.has(j.status));

  return (
    <Paper sx={{ p: 3, mb: 2 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 0.5 }}>
        <ClosedCaptionIcon color="primary" />
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          {translate("padmakara.subtitles.title")}
          {videoLabel && (
            <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1, fontWeight: 400 }}>
              — {videoLabel}
            </Typography>
          )}
        </Typography>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {translate("padmakara.subtitles.description")}
      </Typography>

      {/* ── Generate English subtitles row ── */}
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, flexWrap: "wrap" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, minHeight: 32 }}>
          {loading ? (
            <Typography variant="body2" color="text.secondary">
              {translate("ra.page.loading")}
            </Typography>
          ) : latestJob ? (
            <>
              <Chip
                label={translate(`padmakara.subtitles.status.${latestJob.status}`, { _: latestJob.status })}
                size="small"
                color={statusColor(latestJob.status)}
              />
              <Typography variant="body2" color="text.secondary">
                {latestJob.language.toUpperCase()} · {formatTimestamp(latestJob.completedAt ?? latestJob.submittedAt ?? latestJob.createdAt)}
              </Typography>
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {translate("padmakara.subtitles.noJobs")}
            </Typography>
          )}
        </Box>

        <Tooltip title={translate("padmakara.subtitles.generateTooltip")}>
          <span>
            <Button
              variant="contained"
              startIcon={<ClosedCaptionIcon />}
              onClick={handleSubmit}
              disabled={submitting || hasActive}
            >
              {submitting
                ? translate("padmakara.subtitles.generating")
                : translate("padmakara.subtitles.generate")}
            </Button>
          </span>
        </Tooltip>
      </Box>

      {hasActive && <LinearProgress sx={{ mt: 2, borderRadius: 1 }} />}

      {latestJob?.status === "failed" && latestJob.errorMessage && (
        <Typography variant="body2" color="error" sx={{ mt: 2 }}>
          {latestJob.errorMessage}
        </Typography>
      )}

      {/* ── Translation section ── */}
      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
        {translate("padmakara.subtitles.translate")}
      </Typography>

      {/* Model selector */}
      {modelsData && modelsData.models.length > 0 && (
        <Box sx={{ mb: 1.5 }}>
          <Tooltip title={translate("padmakara.subtitles.modelHint")}>
            <FormControl size="small" sx={{ minWidth: 320 }}>
              <InputLabel id="translate-model-label">
                {translate("padmakara.subtitles.model")}
              </InputLabel>
              <Select
                labelId="translate-model-label"
                value={selectedModel}
                label={translate("padmakara.subtitles.model")}
                onChange={(e) => setSelectedModel(String(e.target.value))}
              >
                {modelsData.models.map((m) => (
                  <MenuItem key={m.id} value={m.id}>
                    {m.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Tooltip>
        </Box>
      )}

      {!hasEnSource && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {translate("padmakara.subtitles.needsSource")}
        </Typography>
      )}

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        {TARGET_LANGS.map((lang) => {
          const inFlight = isLangInFlight(lang);
          return (
            <Tooltip
              key={lang}
              title={
                !hasEnSource
                  ? translate("padmakara.subtitles.needsSource")
                  : inFlight
                    ? translate("padmakara.subtitles.translating")
                    : translate("padmakara.subtitles.translateTo", { language: LANG_NAMES[lang] })
              }
            >
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<TranslateIcon />}
                  onClick={() => handleTranslate(lang)}
                  disabled={!hasEnSource || inFlight || translatingLang === lang}
                >
                  {inFlight || translatingLang === lang
                    ? translate("padmakara.subtitles.translating")
                    : translate("padmakara.subtitles.translateTo", { language: LANG_NAMES[lang] })}
                </Button>
              </span>
            </Tooltip>
          );
        })}
      </Box>

      {/* ── Existing subtitle tracks ── */}
      {subtitles.length > 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
            {translate("padmakara.subtitles.tracks")}
          </Typography>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {subtitles.map((sub) => (
              <Box
                key={sub.id}
                sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", fontSize: "0.8125rem" }}
              >
                {/* Language label */}
                <Chip
                  label={sub.label || sub.language.toUpperCase()}
                  size="small"
                  color="success"
                  sx={{ minWidth: 60 }}
                />

                {/* source badge */}
                <Chip
                  label={
                    sub.source === "human"
                      ? translate("padmakara.subtitles.sourceHuman")
                      : translate("padmakara.subtitles.sourceAuto")
                  }
                  size="small"
                  variant="outlined"
                  color={sub.source === "human" ? "primary" : "default"}
                  sx={{ fontSize: "0.7rem" }}
                />

                {/* stale warning */}
                {sub.stale && (
                  <Tooltip title={translate("padmakara.subtitles.stale")}>
                    <Chip
                      icon={<WarningAmberIcon sx={{ fontSize: 14 }} />}
                      label={translate("padmakara.subtitles.stale")}
                      size="small"
                      color="warning"
                      sx={{ fontSize: "0.7rem" }}
                    />
                  </Tooltip>
                )}

                <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 60 }}>
                  {sub.origin}
                </Typography>

                {/* Download */}
                <Button
                  size="small"
                  startIcon={<DownloadIcon sx={{ fontSize: 14 }} />}
                  onClick={() => handleDownload(sub.language)}
                  disabled={downloadingLang === sub.language}
                  sx={{ textTransform: "none", fontSize: "0.75rem" }}
                >
                  {translate("padmakara.subtitles.download")}
                </Button>

                {/* Replace */}
                <Tooltip title={translate("padmakara.subtitles.replaceHint")}>
                  <span>
                    <Button
                      component="label"
                      size="small"
                      variant="outlined"
                      startIcon={<UploadFileIcon sx={{ fontSize: 14 }} />}
                      disabled={replacingLang === sub.language}
                      sx={{ textTransform: "none", fontSize: "0.75rem" }}
                    >
                      {translate("padmakara.subtitles.replace")}
                      <input
                        type="file"
                        accept=".vtt"
                        hidden
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            void handleReplace(sub.language, file);
                          }
                          // Reset so the same file can be re-selected if needed.
                          e.target.value = "";
                        }}
                      />
                    </Button>
                  </span>
                </Tooltip>
              </Box>
            ))}
          </Box>
        </>
      )}

      {subtitles.length === 0 && !loading && jobs.length === 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="caption" color="text.secondary">
            {translate("padmakara.subtitles.noTracks")}
          </Typography>
        </>
      )}

      {/* ── Recent jobs history ── */}
      {jobs.length > 1 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
            {translate("padmakara.subtitles.recentJobs")}
          </Typography>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
            {jobs.slice(1, 5).map((job) => (
              <Box
                key={job.id}
                sx={{ display: "flex", alignItems: "center", gap: 1.5, fontSize: "0.8125rem" }}
              >
                <Chip
                  label={translate(`padmakara.subtitles.status.${job.status}`, { _: job.status })}
                  size="small"
                  color={statusColor(job.status)}
                  sx={{ minWidth: 90 }}
                />
                <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                  {job.language.toUpperCase()} · {formatTimestamp(job.completedAt ?? job.submittedAt ?? job.createdAt)}
                </Typography>
                {job.errorMessage && (
                  <Tooltip title={job.errorMessage}>
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
