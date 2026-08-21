/**
 * Title-slide editor — a dialog for authoring the intro/outro slide
 * sequence burned in front of/behind an event video. Reused for two rather
 * different callers (see EventVideosSection.tsx):
 *
 *  - An EXISTING video: `useVideoSlides()` below owns the GET/PUT/POST-
 *    defaults network calls; the row's "Slides" button opens this dialog
 *    wired to that hook's `save`/`generateDefaults`.
 *  - A DRAFT for the next upload (no video id yet, since slides are always
 *    scoped to `event_videos.id`): the caller keeps a local `SlideDocument`
 *    and passes a synchronous `onSave`, with `onGenerateDefaults` omitted
 *    (there is no event_video row yet to generate defaults from).
 *
 * The editor itself doesn't know which mode it's in — it only edits a
 * SlideDocument and reports it back through `onSave`. See the design doc:
 * docs/superpowers/specs/2026-08-21-video-slides-burn-in-design.md
 */

import AddIcon from "@mui/icons-material/Add";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ImageIcon from "@mui/icons-material/Image";
import MovieCreationIcon from "@mui/icons-material/MovieCreation";
import SaveIcon from "@mui/icons-material/Save";
import ShortTextIcon from "@mui/icons-material/ShortText";
import HorizontalRuleIcon from "@mui/icons-material/HorizontalRule";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNotify, useTranslate } from "react-admin";
import { builtinFilename, isBuiltinKey } from "@slides/defaults.ts";
import { emptySlideDocument, hasAnySlides, type Line, type Slide, type SlideDocument } from "@slides/types.ts";
import { authFetch } from "../utils/authFetch";
import {
  addLine,
  addSlide,
  deleteLine,
  deleteSlide,
  duplicateSlide,
  moveLine,
  moveSlide,
  newImageLine,
  newSpacerLine,
  newTextLine,
  type SlideSequenceKey,
  updateSlide,
} from "../utils/slideDocument";
import { SlideEditorPreview } from "./SlideEditorPreview";
import { SlideLineRow } from "./SlideLineRow";

const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const SEQUENCES: SlideSequenceKey[] = ["intro", "outro"];

/* ───────── Data hook for an EXISTING video's slides (GET/PUT/POST) ───────── */

export interface VideoSlidesState {
  loading: boolean;
  doc: SlideDocument;
  hasBurnedSlides: boolean;
  burnStatus: string | null;
  burnError: string | null;
  saving: boolean;
  generating: boolean;
  save: (doc: SlideDocument) => Promise<boolean>;
  generateDefaults: () => Promise<SlideDocument | null>;
  refresh: () => Promise<void>;
}

interface SlidesApiResponse {
  slides: SlideDocument | null;
  hasBurnedSlides: boolean;
  burnStatus: string | null;
  burnError: string | null;
}

export function useVideoSlides(videoId: number): VideoSlidesState {
  const translate = useTranslate();
  const notify = useNotify();
  const [doc, setDoc] = useState<SlideDocument>(emptySlideDocument());
  const [hasBurnedSlides, setHasBurnedSlides] = useState(false);
  const [burnStatus, setBurnStatus] = useState<string | null>(null);
  const [burnError, setBurnError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);

  const applyResponse = useCallback((data: SlidesApiResponse) => {
    setDoc(data.slides ?? emptySlideDocument());
    setHasBurnedSlides(!!data.hasBurnedSlides);
    setBurnStatus(data.burnStatus ?? null);
    setBurnError(data.burnError ?? null);
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await authFetch(`/api/admin/videos/${videoId}/slides`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyResponse(await res.json());
    } catch {
      // Silent — mirrors useVideoSubtitles: a hard failure here shouldn't
      // crash the row, and there's no poll loop that would otherwise retry.
    } finally {
      setLoading(false);
    }
  }, [videoId, applyResponse]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const save = useCallback(
    async (next: SlideDocument): Promise<boolean> => {
      setSaving(true);
      try {
        const res = await authFetch(`/api/admin/videos/${videoId}/slides`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slides: next }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}) as { error?: { message?: string } });
          throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
        }
        applyResponse(await res.json());
        notify(translate("padmakara.slides.saved") || "Slides saved", { type: "success" });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(`${translate("padmakara.slides.saveFailed") || "Could not save slides"}: ${msg}`, {
          type: "error",
        });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [videoId, applyResponse, notify, translate],
  );

  const generateDefaults = useCallback(async (): Promise<SlideDocument | null> => {
    setGenerating(true);
    try {
      const res = await authFetch(`/api/admin/videos/${videoId}/slides/defaults`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { slides: SlideDocument };
      return data.slides;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`${translate("padmakara.slides.generateFailed") || "Could not generate slides"}: ${msg}`, {
        type: "error",
      });
      return null;
    } finally {
      setGenerating(false);
    }
  }, [videoId, notify, translate]);

  return { loading, doc, hasBurnedSlides, burnStatus, burnError, saving, generating, save, generateDefaults, refresh: fetchData };
}

/* ───────── Row chip: at-a-glance burn pipeline status ───────── */

const BURN_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: "rgba(0,0,0,0.05)", text: "text.secondary" },
  queued: { bg: "#eff6ff", text: "#1d4ed8" },
  running: { bg: "#fffbeb", text: "#b45309" },
  done: { bg: "#f0fdf4", text: "#15803d" },
  failed: { bg: "#fef2f2", text: "#b91c1c" },
};

interface BurnStatusChipProps {
  status: string | null;
  error: string | null;
}

/** Renders nothing for "none" (the DB default — no burn pipeline activity
 *  yet, e.g. a video with no slides or one flagged "already has slides
 *  burnt in") so old/unaffected rows look exactly as before. */
export const BurnStatusChip = ({ status, error }: BurnStatusChipProps) => {
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

  if (status === "failed" && error) {
    return <Tooltip title={error}>{chip}</Tooltip>;
  }
  return chip;
};

/* ───────── The editor dialog itself ───────── */

export interface PendingUploadSlides {
  slides: SlideDocument | null;
  hasBurnedSlides: boolean;
}

export interface SlideEditorProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Needed for image-line uploads (presign-file) — see ImageLineEditor. */
  eventCode?: string;
  /** Needed to resolve already-saved image s3Keys to previewable URLs (see
   *  the image-urls fetch below). Omitted for the pre-upload draft editor —
   *  there is no event_video row yet, so every image line in that document
   *  is necessarily a fresh upload already covered by the blob cache. */
  videoId?: number;
  /** Needed so "Generate from event data" works in draft mode (no videoId
   *  yet — see AddVideoDialog.tsx). When `onGenerateDefaults` isn't given
   *  explicitly, the editor falls back to calling the event-scoped
   *  POST /api/admin/events/:id/slides/defaults itself using this id. Not
   *  needed when `onGenerateDefaults` IS given (the existing-video case —
   *  useVideoSlides already wires up the video-scoped equivalent). */
  eventId?: number;
  initialDocument: SlideDocument;
  onSave: (doc: SlideDocument) => Promise<boolean | void> | boolean | void;
  saving?: boolean;
  /** Explicit override for "Generate from event data" — used for an
   *  EXISTING video (useVideoSlides.generateDefaults, video-scoped: prefers
   *  the video's own date). Omit to fall back to the event-scoped generator
   *  driven by `eventId` above (draft/pre-upload mode). */
  onGenerateDefaults?: () => Promise<SlideDocument | null>;
  generating?: boolean;
  burnStatus?: string | null;
  burnError?: string | null;
}

export const SlideEditor = ({
  open,
  onClose,
  title,
  eventCode,
  videoId,
  eventId,
  initialDocument,
  onSave,
  saving,
  onGenerateDefaults,
  generating,
  burnStatus,
  burnError,
}: SlideEditorProps) => {
  const translate = useTranslate();
  const notify = useNotify();
  const [doc, setDoc] = useState<SlideDocument>(initialDocument);
  const [tab, setTab] = useState<SlideSequenceKey>("intro");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [localSaving, setLocalSaving] = useState(false);
  const blobUrls = useRef<Map<string, string>>(new Map());
  // Presigned GET URLs for image s3Keys that came from an already-saved
  // slide document (as opposed to a fresh upload in this session, which
  // lives in blobUrls above). Populated by the effect below.
  const remoteUrls = useRef<Map<string, string>>(new Map());
  const [, forceRerender] = useReducer((c: number) => c + 1, 0);

  // Re-seed from whatever the caller currently has whenever the dialog opens
  // — covers both "existing video" (freshly fetched doc) and "draft" (the
  // parent's in-progress local document) callers.
  useEffect(() => {
    if (!open) return;
    setDoc(initialDocument);
    setTab("intro");
    setSelectedIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(
    () => () => {
      for (const url of blobUrls.current.values()) URL.revokeObjectURL(url);
    },
    [],
  );

  // Resolve already-saved image lines (neither builtin nor a blob from this
  // session) to presigned URLs in one batched call, so the preview can show
  // an image line that was uploaded in a previous editing session. Draft
  // mode (no videoId yet) has nothing to resolve — every image there is
  // necessarily a fresh upload already covered by blobUrls.
  useEffect(() => {
    if (!open || !videoId) return;
    const keys = new Set<string>();
    for (const seq of SEQUENCES) {
      for (const s of initialDocument[seq]) {
        for (const line of s.lines) {
          if (line.type !== "image" || !line.s3Key) continue;
          if (isBuiltinKey(line.s3Key)) continue;
          if (blobUrls.current.has(line.s3Key)) continue;
          keys.add(line.s3Key);
        }
      }
    }
    if (keys.size === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`/api/admin/videos/${videoId}/slides/image-urls`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ s3Keys: [...keys] }),
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { urls: Record<string, string> };
        for (const [key, url] of Object.entries(data.urls)) {
          remoteUrls.current.set(key, url);
        }
        if (!cancelled) forceRerender();
      } catch {
        // Silent — mirrors fetchData above: the affected images just stay
        // unresolved in the preview instead of crashing the dialog.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, videoId, initialDocument]);

  const resolveImageUrl = useCallback((key: string): string => {
    if (!key) return TRANSPARENT_PIXEL;
    if (isBuiltinKey(key)) return `/images/${builtinFilename(key)}`;
    return blobUrls.current.get(key) ?? remoteUrls.current.get(key) ?? TRANSPARENT_PIXEL;
  }, []);

  const handleImageUploaded = useCallback((key: string, file: File) => {
    const prev = blobUrls.current.get(key);
    if (prev) URL.revokeObjectURL(prev);
    blobUrls.current.set(key, URL.createObjectURL(file));
    forceRerender();
  }, []);

  const dirty = useMemo(() => JSON.stringify(doc) !== JSON.stringify(initialDocument), [doc, initialDocument]);

  const activeSlides = doc[tab];
  const safeIndex = activeSlides.length === 0 ? 0 : Math.min(selectedIndex, activeSlides.length - 1);

  const handleTabChange = (_: React.SyntheticEvent, value: SlideSequenceKey) => {
    setTab(value);
    setSelectedIndex(0);
  };

  const handleAddSlide = () => {
    setDoc((d) => addSlide(d, tab));
    setSelectedIndex(activeSlides.length);
  };

  const handleDuplicateSlide = (slideId: string) => {
    const idx = activeSlides.findIndex((s) => s.id === slideId);
    setDoc((d) => duplicateSlide(d, tab, slideId));
    if (idx >= 0) setSelectedIndex(idx + 1);
  };

  const handleDeleteSlide = (slideId: string) => {
    setDoc((d) => deleteSlide(d, tab, slideId));
  };

  const handleMoveSlide = (slideId: string, direction: -1 | 1) => {
    const idx = activeSlides.findIndex((s) => s.id === slideId);
    setDoc((d) => moveSlide(d, tab, slideId, direction));
    if (idx === selectedIndex) setSelectedIndex(idx + direction);
  };

  // Draft mode (no videoId → no video-scoped useVideoSlides hook to supply
  // onGenerateDefaults) falls back to the event-scoped defaults route, so
  // "Generate from event data" is just as usable before a video exists as
  // after — slides are meant to be authored BEFORE the upload, not after.
  const [eventGenerating, setEventGenerating] = useState(false);
  const generateFromEvent = useCallback(async (): Promise<SlideDocument | null> => {
    if (!eventId) return null;
    setEventGenerating(true);
    try {
      const res = await authFetch(`/api/admin/events/${eventId}/slides/defaults`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { slides: SlideDocument };
      return data.slides;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(`${translate("padmakara.slides.generateFailed") || "Could not generate slides"}: ${msg}`, {
        type: "error",
      });
      return null;
    } finally {
      setEventGenerating(false);
    }
  }, [eventId, notify, translate]);

  const effectiveGenerateDefaults = onGenerateDefaults ?? (eventId ? generateFromEvent : undefined);
  const effectiveGenerating = onGenerateDefaults ? (generating ?? false) : eventGenerating;

  const handleGenerate = async () => {
    if (!effectiveGenerateDefaults) return;
    if (hasAnySlides(doc)) {
      const ok = window.confirm(
        translate("padmakara.slides.generateConfirm") ||
          "This replaces the current slides with a template generated from the event's data. Continue?",
      );
      if (!ok) return;
    }
    const generated = await effectiveGenerateDefaults();
    if (generated) {
      setDoc(generated);
      setTab("intro");
      setSelectedIndex(0);
    }
  };

  const handleSave = async () => {
    setLocalSaving(true);
    try {
      const result = await onSave(doc);
      if (result !== false) onClose();
    } finally {
      setLocalSaving(false);
    }
  };

  const handleRequestClose = () => {
    if (dirty) {
      const ok = window.confirm(
        translate("padmakara.slides.unsavedConfirm") || "Discard unsaved changes to the slides?",
      );
      if (!ok) return;
    }
    onClose();
  };

  const isSaving = saving ?? localSaving;

  return (
    <Dialog open={open} onClose={handleRequestClose} maxWidth="lg" fullWidth slotProps={{ paper: { sx: { height: "88vh" } } }}>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1.5, pr: 6 }}>
        <MovieCreationIcon sx={{ color: "primary.main" }} />
        <Typography variant="h6" sx={{ fontWeight: 600, fontSize: "1.05rem", flex: 1 }} noWrap>
          {title}
        </Typography>
        <BurnStatusChip status={burnStatus ?? null} error={burnError ?? null} />
        <IconButton onClick={handleRequestClose} sx={{ position: "absolute", right: 12, top: 12 }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <Box sx={{ px: 3, display: "flex", alignItems: "center", gap: 2, borderBottom: "1px solid rgba(0,0,0,0.08)" }}>
        <Tabs value={tab} onChange={handleTabChange} sx={{ minHeight: 40 }}>
          <Tab
            value="intro"
            label={`${translate("padmakara.slides.intro") || "Intro"} (${doc.intro.length})`}
            sx={{ minHeight: 40, textTransform: "none", fontSize: "0.85rem" }}
          />
          <Tab
            value="outro"
            label={`${translate("padmakara.slides.outro") || "Outro"} (${doc.outro.length})`}
            sx={{ minHeight: 40, textTransform: "none", fontSize: "0.85rem" }}
          />
        </Tabs>
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          startIcon={effectiveGenerating ? <CircularProgress size={14} /> : <AutoAwesomeIcon sx={{ fontSize: 16 }} />}
          disabled={!effectiveGenerateDefaults || effectiveGenerating}
          onClick={() => void handleGenerate()}
          sx={{ textTransform: "none", fontSize: "0.78rem" }}
        >
          {translate("padmakara.slides.generateFromEvent") || "Generate from event data"}
        </Button>
      </Box>

      <DialogContent sx={{ display: "flex", gap: 3, p: 3, overflow: "hidden" }}>
        <Box sx={{ flex: "1 1 60%", overflowY: "auto", pr: 1 }}>
          {activeSlides.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", mb: 2 }}>
              {translate("padmakara.slides.empty") || "No slides yet"}
            </Typography>
          )}
          {activeSlides.map((slide, idx) => (
            <SlideCard
              key={slide.id}
              slide={slide}
              index={idx}
              isFirst={idx === 0}
              isLast={idx === activeSlides.length - 1}
              selected={idx === safeIndex}
              eventCode={eventCode}
              resolveImageUrl={resolveImageUrl}
              onSelect={() => setSelectedIndex(idx)}
              onUpdateSlide={(patch) => setDoc((d) => updateSlide(d, tab, slide.id, patch))}
              onDuplicate={() => handleDuplicateSlide(slide.id)}
              onDelete={() => handleDeleteSlide(slide.id)}
              onMoveUp={() => handleMoveSlide(slide.id, -1)}
              onMoveDown={() => handleMoveSlide(slide.id, 1)}
              onAddLine={(line) => setDoc((d) => addLine(d, tab, slide.id, line))}
              onUpdateLine={(line) =>
                setDoc((d) => ({
                  ...d,
                  [tab]: d[tab].map((s) =>
                    s.id === slide.id ? { ...s, lines: s.lines.map((l) => (l.id === line.id ? line : l)) } : s,
                  ),
                }))
              }
              onDeleteLine={(lineId) => setDoc((d) => deleteLine(d, tab, slide.id, lineId))}
              onMoveLine={(lineId, direction) => setDoc((d) => moveLine(d, tab, slide.id, lineId, direction))}
              onImageUploaded={handleImageUploaded}
            />
          ))}
          <Button
            size="small"
            startIcon={<AddIcon sx={{ fontSize: 16 }} />}
            onClick={handleAddSlide}
            sx={{ textTransform: "none", fontSize: "0.8rem", mt: 1 }}
          >
            {translate("padmakara.slides.addSlide") || "Add slide"}
          </Button>
        </Box>

        <Box sx={{ flex: "1 1 40%", minWidth: 320, maxWidth: 460 }}>
          <SlideEditorPreview
            slides={activeSlides}
            selectedIndex={safeIndex}
            onSelectIndex={setSelectedIndex}
            resolveImageUrl={resolveImageUrl}
          />
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2, borderTop: "1px solid rgba(0,0,0,0.08)" }}>
        <Button onClick={handleRequestClose} color="inherit" sx={{ textTransform: "none" }}>
          {translate("padmakara.slides.cancel") || translate("ra.action.cancel") || "Cancel"}
        </Button>
        <Button
          variant="contained"
          disableElevation
          disabled={!dirty || isSaving}
          startIcon={isSaving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon sx={{ fontSize: 16 }} />}
          onClick={() => void handleSave()}
          sx={{ textTransform: "none" }}
        >
          {translate("padmakara.slides.save") || "Save"}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

/* ───────── One slide card: timing + line list ───────── */

interface SlideCardProps {
  slide: Slide;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  selected: boolean;
  eventCode?: string;
  resolveImageUrl: (s3Key: string) => string;
  onSelect: () => void;
  onUpdateSlide: (patch: Partial<Pick<Slide, "durationMs" | "fadeMs">>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAddLine: (line: Line) => void;
  onUpdateLine: (line: Line) => void;
  onDeleteLine: (lineId: string) => void;
  onMoveLine: (lineId: string, direction: -1 | 1) => void;
  onImageUploaded: (s3Key: string, file: File) => void;
}

const SlideCard = ({
  slide,
  index,
  isFirst,
  isLast,
  selected,
  eventCode,
  resolveImageUrl,
  onSelect,
  onUpdateSlide,
  onDuplicate,
  onDelete,
  onMoveUp,
  onMoveDown,
  onAddLine,
  onUpdateLine,
  onDeleteLine,
  onMoveLine,
  onImageUploaded,
}: SlideCardProps) => {
  const translate = useTranslate();
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);

  const addLineOfType = (type: "text" | "image" | "spacer") => {
    setAddAnchor(null);
    if (type === "text") onAddLine(newTextLine());
    else if (type === "image") onAddLine(newImageLine());
    else onAddLine(newSpacerLine());
  };

  return (
    <Paper
      variant="outlined"
      onClick={onSelect}
      // Focus moving into any field inside this card selects it too, so the
      // preview follows the caret — including when tabbing between lines,
      // which a click handler alone never catches.
      onFocusCapture={onSelect}
      sx={{
        p: 1.5,
        mb: 1.5,
        cursor: "pointer",
        borderColor: selected ? "primary.main" : undefined,
        borderWidth: selected ? 2 : 1,
        backgroundColor: selected ? "rgba(91,94,166,0.03)" : undefined,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
        <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary", width: 22 }}>
          {index + 1}
        </Typography>
        <TextField
          size="small"
          type="number"
          label={translate("padmakara.slides.duration") || "Duration (s)"}
          value={slide.durationMs / 1000}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onUpdateSlide({ durationMs: Math.max(0, Number(e.target.value) || 0) * 1000 })}
          sx={{ width: 96 }}
          slotProps={{ htmlInput: { min: 0, step: 0.5 }, inputLabel: { shrink: true } }}
        />
        <TextField
          size="small"
          type="number"
          label={translate("padmakara.slides.fade") || "Fade (ms)"}
          value={slide.fadeMs}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onUpdateSlide({ fadeMs: Math.max(0, Number(e.target.value) || 0) })}
          sx={{ width: 96 }}
          slotProps={{ htmlInput: { min: 0, step: 50 }, inputLabel: { shrink: true } }}
        />
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" disabled={isFirst} onClick={(e) => { e.stopPropagation(); onMoveUp(); }}>
          <ArrowUpwardIcon sx={{ fontSize: 15 }} />
        </IconButton>
        <IconButton size="small" disabled={isLast} onClick={(e) => { e.stopPropagation(); onMoveDown(); }}>
          <ArrowDownwardIcon sx={{ fontSize: 15 }} />
        </IconButton>
        <Tooltip title={translate("padmakara.slides.duplicateSlide") || "Duplicate slide"}>
          <IconButton size="small" onClick={(e) => { e.stopPropagation(); onDuplicate(); }}>
            <ContentCopyIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title={translate("padmakara.slides.deleteSlide") || "Delete slide"}>
          <IconButton size="small" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
            <DeleteOutlineIcon sx={{ fontSize: 15, color: "text.secondary" }} />
          </IconButton>
        </Tooltip>
      </Box>

      <Divider sx={{ mb: 1 }} />

      <Box onClick={(e) => e.stopPropagation()}>
        {slide.lines.map((line, lineIdx) => (
          <SlideLineRow
            key={line.id}
            line={line}
            isFirst={lineIdx === 0}
            isLast={lineIdx === slide.lines.length - 1}
            eventCode={eventCode}
            resolveImageUrl={resolveImageUrl}
            onChange={onUpdateLine}
            onDelete={() => onDeleteLine(line.id)}
            onMoveUp={() => onMoveLine(line.id, -1)}
            onMoveDown={() => onMoveLine(line.id, 1)}
            onImageUploaded={onImageUploaded}
          />
        ))}

        <Button
          size="small"
          startIcon={<AddIcon sx={{ fontSize: 14 }} />}
          onClick={(e) => setAddAnchor(e.currentTarget)}
          sx={{ textTransform: "none", fontSize: "0.72rem", mt: 0.5 }}
        >
          {translate("padmakara.slides.addLine") || "Add line"}
        </Button>
        <Menu anchorEl={addAnchor} open={!!addAnchor} onClose={() => setAddAnchor(null)}>
          <MenuItem onClick={() => addLineOfType("text")}>
            <ShortTextIcon sx={{ fontSize: 16, mr: 1 }} />
            {translate("padmakara.slides.lineTypeText") || "Text"}
          </MenuItem>
          <MenuItem onClick={() => addLineOfType("image")}>
            <ImageIcon sx={{ fontSize: 16, mr: 1 }} />
            {translate("padmakara.slides.lineTypeImage") || "Image"}
          </MenuItem>
          <MenuItem onClick={() => addLineOfType("spacer")}>
            <HorizontalRuleIcon sx={{ fontSize: 16, mr: 1 }} />
            {translate("padmakara.slides.lineTypeSpacer") || "Spacer"}
          </MenuItem>
        </Menu>
      </Box>
    </Paper>
  );
};

