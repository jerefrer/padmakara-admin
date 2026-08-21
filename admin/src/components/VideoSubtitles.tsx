/**
 * Per-video subtitle management, embedded in the EventVideosSection rows.
 *
 * The row shows compact per-language chips (EN, PT, …) that reflect the
 * current subtitle state at a glance; clicking a chip expands an inline
 * details area with only the actions that currently make sense:
 *   - nothing at all while the video is still transcoding,
 *   - "Generate subtitles" when no track exists yet,
 *   - per-track Download / Replace (+ Re-translate only when out of date),
 *   - "Translate to X" only for languages that are still missing,
 *   - a status line only while a Batch job is running or has failed.
 */

import CancelIcon from "@mui/icons-material/Cancel";
import CheckIcon from "@mui/icons-material/Check";
import ClosedCaptionOutlinedIcon from "@mui/icons-material/ClosedCaptionOutlined";
import DownloadIcon from "@mui/icons-material/Download";
import ClearIcon from "@mui/icons-material/Close";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ReplayIcon from "@mui/icons-material/Replay";
import TranslateIcon from "@mui/icons-material/Translate";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useRef, useState } from "react";
import { Confirm, useNotify, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";
import { friendlyJobError } from "../utils/friendlyJobError";
import { LANG_CHIP_COLORS, DEFAULT_LANG_CHIP, LangTag } from "./inlineEditKit";

export interface SubtitleJob {
  id: string;
  status: string;
  language: string;
  errorMessage: string | null;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
}

export interface SubtitleTrack {
  id: number;
  videoId: number;
  language: string;
  label: string;
  origin: string; // "transcription" | "translation"
  source: string; // "auto" | "human"
  stale: boolean;
}

const TERMINAL_STATUSES = new Set(["completed", "failed"]);
const TARGET_LANGS = ["pt", "es", "fr"] as const;
const LANG_ORDER = ["en", "pt", "es", "fr"];

const langSort = (a: SubtitleTrack, b: SubtitleTrack) => {
  const ia = LANG_ORDER.indexOf(a.language);
  const ib = LANG_ORDER.indexOf(b.language);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
};

/* ───────── Data + actions hook (one instance per video row) ───────── */

export interface VideoSubtitlesState {
  loading: boolean;
  tracks: SubtitleTrack[];
  activeJob: SubtitleJob | null;
  failedJob: SubtitleJob | null;
  hasEn: boolean;
  busyLang: string | null;
  /**
   * Whether the video's event has an English transcript on file — null
   * while unknown (still loading, or the check failed silently). Gates the
   * "no transcript" confirmation before generating/regenerating.
   */
  hasTranscript: boolean | null;
  cancellingJobId: string | null;
  generate: (lang?: string, acknowledgeNoTranscript?: boolean) => Promise<void>;
  translateTo: (lang: string) => Promise<void>;
  download: (lang: string) => Promise<void>;
  replace: (lang: string, file: File) => Promise<void>;
  cancel: (jobId: string) => Promise<void>;
  /** Delete a terminal job row (clears a read failure from the row). */
  clearJob: (jobId: string) => Promise<void>;
}

export function useVideoSubtitles(videoId: number): VideoSubtitlesState {
  const translate = useTranslate();
  const notify = useNotify();
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [jobs, setJobs] = useState<SubtitleJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyLang, setBusyLang] = useState<string | null>(null);
  const [hasTranscript, setHasTranscript] = useState<boolean | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await authFetch(`/api/admin/videos/${videoId}/subtitles`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { jobs: SubtitleJob[]; subtitles: SubtitleTrack[] };
      setJobs(data.jobs ?? []);
      setTracks((data.subtitles ?? []).sort(langSort));
    } catch {
      // Silent — the 10s poll retries; surfacing every fetch error is noisy.
    } finally {
      setLoading(false);
    }

    // Independent of the fetch above — generation always targets English
    // here, so that's the only language worth checking. A failure leaves
    // hasTranscript at whatever it last was rather than clearing it.
    try {
      const res = await authFetch(
        `/api/admin/subtitle-jobs/transcript-status?videoId=${videoId}&language=en`,
      );
      if (res.ok) {
        const data = (await res.json()) as { hasTranscript: boolean };
        setHasTranscript(data.hasTranscript);
      }
    } catch {
      // Silent — see above.
    }
  }, [videoId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Poll while a Batch job is in flight so chips/status update on their own.
  const hasActiveJob = jobs.some((j) => !TERMINAL_STATUSES.has(j.status));
  useEffect(() => {
    if (!hasActiveJob) return;
    pollTimer.current = setTimeout(() => void fetchData(), 10_000);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [hasActiveJob, jobs, fetchData]);

  const post = useCallback(
    async (lang: string, path: string, body: Record<string, unknown> = {}) => {
      setBusyLang(lang);
      try {
        const res = await authFetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          throw new Error(errBody.error?.message ?? `HTTP ${res.status}`);
        }
        notify(translate("padmakara.subtitles.submittedSuccess"), { type: "success" });
        await fetchData();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(`${translate("padmakara.subtitles.submitFailed")}: ${msg}`, { type: "error" });
      } finally {
        setBusyLang(null);
      }
    },
    [fetchData, notify, translate],
  );

  // POSTs to /admin/subtitle-jobs rather than /admin/videos/:videoId/subtitles
  // — the latter has no way to carry acknowledgeNoTranscript through, so it
  // always refuses when the event has no transcript. This is the path that
  // can pass the acknowledgement once the confirm dialog has been accepted.
  const generate = useCallback(
    (lang = "en", acknowledgeNoTranscript = false) =>
      post(lang, `/api/admin/subtitle-jobs`, { videoId, language: lang, acknowledgeNoTranscript }),
    [post, videoId],
  );

  const translateTo = useCallback(
    (lang: string) => post(lang, `/api/admin/videos/${videoId}/subtitles/${lang}/translate`),
    [post, videoId],
  );

  const download = useCallback(
    async (lang: string) => {
      try {
        const res = await authFetch(`/api/admin/videos/${videoId}/subtitles/${lang}/download`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = new Blob([await res.text()], { type: "text/vtt" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${lang}.vtt`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(`${translate("padmakara.subtitles.downloadFailed")}: ${msg}`, { type: "error" });
      }
    },
    [notify, translate, videoId],
  );

  const replace = useCallback(
    async (lang: string, file: File) => {
      setBusyLang(lang);
      try {
        const text = await file.text();
        if (!text.startsWith("WEBVTT")) {
          notify(translate("padmakara.subtitles.notWebVtt"), { type: "error" });
          return;
        }
        const res = await authFetch(`/api/admin/videos/${videoId}/subtitles/${lang}`, {
          method: "PUT",
          headers: { "Content-Type": "text/vtt" },
          body: text,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        notify(translate("padmakara.subtitles.replaced"), { type: "success" });
        await fetchData();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(`${translate("padmakara.subtitles.replaceFailed")}: ${msg}`, { type: "error" });
      } finally {
        setBusyLang(null);
      }
    },
    [fetchData, notify, translate, videoId],
  );

  const cancel = useCallback(
    async (jobId: string) => {
      setCancellingJobId(jobId);
      try {
        const res = await authFetch(`/api/admin/subtitle-jobs/${jobId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        notify(translate("padmakara.subtitles.cancelledSuccess"), { type: "success" });
        await fetchData();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(`${translate("padmakara.subtitles.cancelFailed")}: ${msg}`, { type: "error" });
      } finally {
        setCancellingJobId(null);
      }
    },
    [fetchData, notify, translate],
  );

  /** Remove a finished job row so a read-and-understood failure stops
   *  occupying the row. Terminal jobs only — the API enforces that too. */
  const clearJob = useCallback(
    async (jobId: string) => {
      setCancellingJobId(jobId);
      try {
        const res = await authFetch(`/api/admin/subtitle-jobs/${jobId}`, { method: "DELETE" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        await fetchData();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(`${translate("padmakara.subtitles.clearFailed")}: ${msg}`, { type: "error" });
      } finally {
        setCancellingJobId(null);
      }
    },
    [fetchData, notify, translate],
  );

  const activeJob = jobs.find((j) => !TERMINAL_STATUSES.has(j.status)) ?? null;
  // A failure is only worth surfacing while it is the latest word on the
  // matter — i.e. the most recent job failed and nothing runs right now.
  const latest = jobs[0] ?? null;
  const failedJob = !activeJob && latest?.status === "failed" ? latest : null;

  return {
    loading,
    tracks,
    activeJob,
    failedJob,
    hasEn: tracks.some((t) => t.language === "en"),
    busyLang,
    hasTranscript,
    cancellingJobId,
    generate,
    translateTo,
    download,
    replace,
    cancel,
    clearJob,
  };
}

/* ───────── Row chips: the at-a-glance subtitle state ───────── */

const chipBaseSx = {
  height: 20,
  fontWeight: 700,
  "& .MuiChip-label": { px: 0.7, fontSize: "0.65rem", letterSpacing: "0.02em" },
  "& .MuiChip-icon": { ml: 0.5, mr: -0.25 },
} as const;

interface SubtitleChipsProps {
  state: VideoSubtitlesState;
  /** Generation needs the transcoded audio — false while Bunny is still processing. */
  canGenerate: boolean;
  open: boolean;
  onToggle: () => void;
}

export const SubtitleChips = ({ state, canGenerate, open, onToggle }: SubtitleChipsProps) => {
  const translate = useTranslate();
  const { loading, tracks, activeJob, failedJob, hasTranscript } = state;
  if (loading) return null;

  const langName = (lang: string) =>
    translate(`padmakara.subtitles.langs.${lang}`, { _: lang.toUpperCase() });

  const chips: React.ReactNode[] = tracks.map((t) => {
    const colors = LANG_CHIP_COLORS[t.language] || DEFAULT_LANG_CHIP;
    const parts = [langName(t.language)];
    if (t.source === "human") parts.push(translate("padmakara.subtitles.verified"));
    if (t.stale) parts.push(translate("padmakara.subtitles.stale"));
    return (
      <Tooltip key={t.language} title={parts.join(" · ")}>
        <Chip
          label={t.language.toUpperCase()}
          size="small"
          onClick={onToggle}
          aria-expanded={open}
          icon={
            t.stale ? (
              <WarningAmberIcon sx={{ fontSize: 12, color: "#b45309 !important" }} />
            ) : t.source === "human" ? (
              <CheckIcon sx={{ fontSize: 12, color: `${colors.text} !important` }} />
            ) : undefined
          }
          sx={{
            ...chipBaseSx,
            backgroundColor: colors.bg,
            color: colors.text,
            ...(t.stale && { boxShadow: "inset 0 0 0 1.5px #f59e0b" }),
            "&:hover": { backgroundColor: colors.bg, filter: "brightness(0.96)" },
          }}
        />
      </Tooltip>
    );
  });

  if (activeJob) {
    chips.push(
      <Tooltip
        key="active"
        title={`${translate("padmakara.subtitles.generatingLang", { language: langName(activeJob.language) })} · ${translate(`padmakara.subtitles.status.${activeJob.status}`, { _: activeJob.status })}`}
      >
        <Chip
          label={activeJob.language.toUpperCase()}
          size="small"
          onClick={onToggle}
          aria-expanded={open}
          icon={<CircularProgress size={10} thickness={5} sx={{ color: "#b45309 !important" }} />}
          sx={{ ...chipBaseSx, backgroundColor: "#fffbeb", color: "#b45309" }}
        />
      </Tooltip>,
    );
  } else if (failedJob && !tracks.some((t) => t.language === failedJob.language)) {
    chips.push(
      <Tooltip key="failed" title={translate("padmakara.subtitles.failedTooltip")}>
        <Chip
          label={failedJob.language.toUpperCase()}
          size="small"
          onClick={onToggle}
          aria-expanded={open}
          icon={<ErrorOutlineIcon sx={{ fontSize: 12, color: "#b91c1c !important" }} />}
          sx={{ ...chipBaseSx, backgroundColor: "#fef2f2", color: "#b91c1c" }}
        />
      </Tooltip>,
    );
  }

  if (chips.length === 0) {
    if (!canGenerate) return null; // still transcoding — nothing to offer yet
    const noTranscript = hasTranscript === false;
    chips.push(
      <Tooltip
        key="none"
        title={
          noTranscript
            ? translate("padmakara.subtitles.noTranscriptWarning")
            : translate("padmakara.subtitles.generate")
        }
      >
        <Chip
          label="CC"
          size="small"
          onClick={onToggle}
          aria-expanded={open}
          icon={
            noTranscript ? (
              <WarningAmberIcon sx={{ fontSize: 13, color: "#b45309 !important" }} />
            ) : (
              <ClosedCaptionOutlinedIcon sx={{ fontSize: 13 }} />
            )
          }
          variant="outlined"
          sx={{
            ...chipBaseSx,
            color: noTranscript ? "#b45309" : "text.disabled",
            borderStyle: "dashed",
            ...(noTranscript && { borderColor: "#f59e0b" }),
            "&:hover": {
              color: noTranscript ? "#b45309" : "text.secondary",
              backgroundColor: noTranscript ? "#fffbeb" : "rgba(91,94,166,0.04)",
            },
          }}
        />
      </Tooltip>,
    );
  }

  return <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>{chips}</Box>;
};

/* ───────── Expanded details: tracks and the actions that apply ───────── */

interface SubtitleDetailsProps {
  state: VideoSubtitlesState;
  canGenerate: boolean;
  bunnyVideoId: string;
}

export const SubtitleDetails = ({ state, canGenerate, bunnyVideoId }: SubtitleDetailsProps) => {
  const translate = useTranslate();
  const { tracks, activeJob, failedJob, hasEn, busyLang, hasTranscript, cancellingJobId } = state;
  const [noTranscriptConfirmOpen, setNoTranscriptConfirmOpen] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);

  const langName = (lang: string) =>
    translate(`padmakara.subtitles.langs.${lang}`, { _: lang.toUpperCase() });
  const missingTargets = TARGET_LANGS.filter((l) => !tracks.some((t) => t.language === l));
  const empty = tracks.length === 0 && !activeJob && !failedJob;

  // English generation/regeneration reads the event transcript to guide
  // Whisper; without one it still works, but produces materially worse
  // output on names and Buddhist terminology. Route every path that ends up
  // calling generate() through here so the confirmation is never skipped.
  const requestGenerate = () => {
    if (hasTranscript === false) {
      setNoTranscriptConfirmOpen(true);
    } else {
      void state.generate();
    }
  };

  return (
    <Box
      sx={{
        px: 2,
        py: 1.25,
        pl: 6.5, // aligns with the row title, past the position number + icon
        borderTop: "1px dashed rgba(0,0,0,0.06)",
        backgroundColor: "rgba(91,94,166,0.025)",
        display: "flex",
        flexDirection: "column",
        gap: 0.75,
      }}
    >
      {/* Running job — the only time a status line exists */}
      {activeJob && (
        <Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <CircularProgress size={12} thickness={5} sx={{ color: "#b45309" }} />
            <Typography variant="caption" sx={{ color: "#b45309", fontWeight: 600, flex: 1 }}>
              {translate("padmakara.subtitles.generatingLang", { language: langName(activeJob.language) })}
              {" · "}
              {translate(`padmakara.subtitles.status.${activeJob.status}`, { _: activeJob.status })}
            </Typography>
            <Button
              size="small"
              color="inherit"
              startIcon={<CancelIcon sx={{ fontSize: 13 }} />}
              disabled={cancellingJobId !== null}
              onClick={() => setCancelConfirmOpen(true)}
              sx={{ textTransform: "none", fontSize: "0.72rem", py: 0, color: "text.secondary" }}
            >
              {translate("padmakara.subtitles.cancel")}
            </Button>
          </Box>
          <LinearProgress sx={{ mt: 0.75, borderRadius: 1, height: 3 }} />
        </Box>
      )}

      {/* Latest job failed and nothing replaced it — error + retry */}
      {failedJob && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <ErrorOutlineIcon sx={{ fontSize: 14, color: "#b91c1c" }} />
          <Tooltip title={failedJob.errorMessage ?? ""}>
            <Typography
              variant="caption"
              sx={{ color: "#b91c1c", flex: 1, minWidth: 120, cursor: failedJob.errorMessage ? "help" : undefined }}
            >
              {translate("padmakara.subtitles.failed", { language: langName(failedJob.language) })}
              {" — "}
              {friendlyJobError(failedJob.errorMessage, translate)}
            </Typography>
          </Tooltip>
          <Button
            size="small"
            color="error"
            startIcon={<ReplayIcon sx={{ fontSize: 14 }} />}
            disabled={busyLang !== null}
            onClick={() =>
              failedJob.language === "en"
                ? requestGenerate()
                : void state.translateTo(failedJob.language)
            }
            sx={{ textTransform: "none", fontSize: "0.72rem", py: 0 }}
          >
            {translate("padmakara.subtitles.retry")}
          </Button>
          <Button
            size="small"
            color="inherit"
            startIcon={<ClearIcon sx={{ fontSize: 14 }} />}
            disabled={busyLang !== null || state.cancellingJobId === failedJob.id}
            onClick={() => void state.clearJob(failedJob.id)}
            sx={{ textTransform: "none", fontSize: "0.72rem", py: 0, color: "text.secondary" }}
          >
            {translate("padmakara.subtitles.clear")}
          </Button>
        </Box>
      )}

      {/* One quiet row per existing track */}
      {tracks.map((t) => (
        <Box key={t.id} sx={{ display: "flex", alignItems: "center", gap: 1, minHeight: 26 }}>
          <LangTag code={t.language} />
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            {langName(t.language)}
          </Typography>
          {t.source === "human" && (
            <Chip
              label={translate("padmakara.subtitles.verified")}
              size="small"
              icon={<CheckIcon sx={{ fontSize: 11 }} />}
              sx={{ ...chipBaseSx, height: 18, backgroundColor: "#eff6ff", color: "#1d4ed8" }}
            />
          )}
          {t.stale && (
            <Tooltip title={translate("padmakara.subtitles.staleHint")}>
              <Chip
                label={translate("padmakara.subtitles.stale")}
                size="small"
                icon={<WarningAmberIcon sx={{ fontSize: 11, color: "#b45309 !important" }} />}
                sx={{ ...chipBaseSx, height: 18, backgroundColor: "#fffbeb", color: "#b45309" }}
              />
            </Tooltip>
          )}
          <Box sx={{ flex: 1 }} />
          {t.stale && t.origin === "translation" && (
            <Tooltip title={translate("padmakara.subtitles.retranslate")}>
              <span>
                <IconButton
                  size="small"
                  disabled={busyLang !== null}
                  onClick={() => void state.translateTo(t.language)}
                >
                  <TranslateIcon sx={{ fontSize: 15 }} />
                </IconButton>
              </span>
            </Tooltip>
          )}
          <Tooltip title={translate("padmakara.subtitles.download")}>
            <IconButton size="small" onClick={() => void state.download(t.language)}>
              <DownloadIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title={translate("padmakara.subtitles.replaceHint")}>
            <span>
              <IconButton size="small" component="label" disabled={busyLang !== null}>
                <UploadFileIcon sx={{ fontSize: 15 }} />
                <input
                  type="file"
                  accept=".vtt"
                  hidden
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const file = e.target.files?.[0];
                    if (file) void state.replace(t.language, file);
                    e.target.value = "";
                  }}
                />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      ))}

      {/* Actions — only what is currently possible */}
      {!activeJob && (empty ? canGenerate : true) && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", minHeight: 26 }}>
          {empty && canGenerate && (
            <>
              <Button
                size="small"
                variant="contained"
                disableElevation
                color={hasTranscript === false ? "warning" : "primary"}
                startIcon={<ClosedCaptionOutlinedIcon sx={{ fontSize: 15 }} />}
                disabled={busyLang !== null}
                onClick={requestGenerate}
                sx={{ textTransform: "none", fontSize: "0.72rem", py: 0.25 }}
              >
                {translate("padmakara.subtitles.generate")}
              </Button>
              {hasTranscript === false ? (
                <Tooltip title={translate("padmakara.subtitles.noTranscriptWarning")}>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.4, cursor: "help" }}>
                    <WarningAmberIcon sx={{ fontSize: 13, color: "#b45309" }} />
                    <Typography variant="caption" sx={{ color: "#b45309" }}>
                      {translate("padmakara.subtitles.noTranscriptHint")}
                    </Typography>
                  </Box>
                </Tooltip>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  {translate("padmakara.subtitles.generateHint")}
                </Typography>
              )}
            </>
          )}

          {hasEn && missingTargets.length > 0 && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                {translate("padmakara.subtitles.translateLabel")}
              </Typography>
              {missingTargets.map((lang) => (
                <Button
                  key={lang}
                  size="small"
                  variant="outlined"
                  disabled={busyLang !== null}
                  onClick={() => void state.translateTo(lang)}
                  sx={{ textTransform: "none", fontSize: "0.72rem", py: 0, px: 1, minWidth: 0 }}
                >
                  {busyLang === lang ? "…" : langName(lang)}
                </Button>
              ))}
            </>
          )}

          <Box sx={{ flex: 1 }} />

          {hasEn && (
            <Tooltip
              title={
                hasTranscript === false
                  ? translate("padmakara.subtitles.noTranscriptWarning")
                  : translate("padmakara.subtitles.regenerateHint")
              }
            >
              <span>
                <Button
                  size="small"
                  color="inherit"
                  startIcon={
                    hasTranscript === false ? (
                      <WarningAmberIcon sx={{ fontSize: 13, color: "#b45309" }} />
                    ) : (
                      <ReplayIcon sx={{ fontSize: 13 }} />
                    )
                  }
                  disabled={busyLang !== null}
                  onClick={requestGenerate}
                  sx={{
                    textTransform: "none",
                    fontSize: "0.72rem",
                    py: 0,
                    color: hasTranscript === false ? "#b45309" : "text.secondary",
                  }}
                >
                  {translate("padmakara.subtitles.regenerate")}
                </Button>
              </span>
            </Tooltip>
          )}

        </Box>
      )}

      {/* Transcoding guard — only reachable via a stale open panel */}
      {empty && !canGenerate && (
        <Typography variant="caption" color="text.secondary">
          {translate("padmakara.subtitles.waitTranscoding")}
        </Typography>
      )}

      <Confirm
        isOpen={noTranscriptConfirmOpen}
        title={translate("padmakara.subtitles.noTranscriptConfirmTitle")}
        content={translate("padmakara.subtitles.noTranscriptConfirmContent")}
        confirm={translate("padmakara.subtitles.noTranscriptConfirmProceed")}
        confirmColor="warning"
        onConfirm={() => {
          setNoTranscriptConfirmOpen(false);
          void state.generate(undefined, true);
        }}
        onClose={() => setNoTranscriptConfirmOpen(false)}
      />

      {activeJob && (
        <Confirm
          isOpen={cancelConfirmOpen}
          title={translate("padmakara.subtitles.cancelConfirmTitle")}
          content={translate("padmakara.subtitles.cancelConfirmContent")}
          confirmColor="warning"
          onConfirm={() => {
            setCancelConfirmOpen(false);
            void state.cancel(activeJob.id);
          }}
          onClose={() => setCancelConfirmOpen(false)}
        />
      )}
    </Box>
  );
};
