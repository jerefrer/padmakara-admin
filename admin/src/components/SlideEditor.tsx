/**
 * Title-slide editor: a full-height dialog for the intro/outro slides burned
 * around one event video. Three columns: the sequence (left), the selected
 * slide, editable in place (centre), and its timing and subtitle (right).
 * Slides are always scoped to an existing video row (the add-video dialog
 * creates it first), so every call here has a `videoId`.
 *
 * `useVideoSlides()` below owns the GET/PUT/POST network calls; the dialog
 * itself only edits a SlideDocument and reports it back through `onSave`.
 */

import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNotify, useTranslate } from "react-admin";
import { builtinFilename, isBuiltinKey } from "@slides/defaults.ts";
import {
  BUILTIN_CLIPS,
  emptySlideDocument,
  hasAnySlides,
  isClipSlide,
  type BuiltinClipId,
  type LineSize,
  type Slide,
  type SlideDocument,
  type Span,
  type TextLine,
} from "@slides/types.ts";
import { slideEditorTokens } from "../slideEditorTokens";
import { authFetch } from "../utils/authFetch";
import {
  SlideGenerationError,
  nothingToGenerateFrom,
  requestDefaultSlides,
  type GeneratedSlides,
  type MissingSlideInput,
  type SlideLanguage,
} from "../utils/slideGeneration";
import {
  addLine,
  addLogoClip,
  addSlide,
  hasLogoClip,
  deleteLine,
  deleteSlide,
  duplicateSlide,
  introSubtitleLanguage,
  markSlideReviewed,
  moveSlide,
  newSpacerLine,
  newTextLine,
  patchTextLine,
  replaceLine,
  updateSlide,
  type SlideSequenceKey,
} from "../utils/slideDocument";
import {
  documentDurationMs,
  formatClock,
  sessionLabel,
  videoBlockState,
  type SessionOption,
} from "../utils/slideSequence";
import { BurnActionButton, BurnStatusChip, type BurnDisk } from "./SlideBurnStatus";
import { SlideCanvas, type CanvasMark, type SlideCanvasHandle } from "./SlideCanvas";
import { SlideEditorPreview } from "./SlideEditorPreview";
import { SlideInspector } from "./SlideInspector";
import { SlideLineToolbar } from "./SlideLineToolbar";
import { SlideSequenceList, type VideoUploadState } from "./SlideSequenceList";

export { BurnActionButton, BurnStatusChip };
export type { BurnDisk };

const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

type Translate = ReturnType<typeof useTranslate>;

/** A readable message for a failed generation; a timeout gets its own wording. */
function generationErrorMessage(err: unknown, translate: Translate): string {
  const prefix = translate("padmakara.slides.generateFailed") || "Could not generate slides";
  if (err instanceof SlideGenerationError && err.kind === "timeout") {
    return (
      translate("padmakara.slides.generateTimeout") ||
      "The server did not answer within 30 seconds. Try again in a moment."
    );
  }
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}

/** What the last generation could not find, in the editor's language. */
function generationNoticeText(missing: MissingSlideInput[], translate: Translate): string | null {
  if (missing.length === 0) return null;
  if (nothingToGenerateFrom(missing)) {
    return (
      translate("padmakara.slides.nothingToGenerate") ||
      "The event has no teacher, title, date, place, organizer or credits yet, so only the logo slide could be generated. Add them to the event and generate again."
    );
  }
  const names = missing.map((key) => translate(`padmakara.slides.missing.${key}`) || key).join(", ");
  return (
    translate("padmakara.slides.missingNotice", { items: names }) ||
    `Add ${names} to the event to include those slides.`
  );
}

/* ───────── Data hook for an EXISTING video's slides (GET/PUT/POST) ───────── */

export interface VideoSlidesState {
  loading: boolean;
  doc: SlideDocument;
  hasBurnedSlides: boolean;
  hasMaster: boolean;
  burnStatus: string | null;
  burnError: string | null;
  burnDisk: BurnDisk | null;
  saving: boolean;
  reburning: boolean;
  generating: boolean;
  copying: boolean;
  /** Another video's slides, session slide flagged for review. Does not save. */
  copyFrom: (sourceVideoId: number) => Promise<CopiedSlides | null>;
  save: (doc: SlideDocument) => Promise<boolean>;
  generateDefaults: (lang: SlideLanguage) => Promise<GeneratedSlides | null>;
  reburn: () => Promise<boolean>;
  refresh: () => Promise<void>;
}

interface SlidesApiResponse {
  slides: SlideDocument | null;
  hasBurnedSlides: boolean;
  hasMaster?: boolean;
  burnStatus: string | null;
  burnError: string | null;
  burnMasterBytes?: number | null;
  burnPeakDiskBytes?: number | null;
}

export function useVideoSlides(videoId: number): VideoSlidesState {
  const translate = useTranslate();
  const notify = useNotify();
  const [doc, setDoc] = useState<SlideDocument>(emptySlideDocument());
  const [hasBurnedSlides, setHasBurnedSlides] = useState(false);
  const [hasMaster, setHasMaster] = useState(false);
  const [burnStatus, setBurnStatus] = useState<string | null>(null);
  const [burnError, setBurnError] = useState<string | null>(null);
  const [burnDisk, setBurnDisk] = useState<BurnDisk | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [reburning, setReburning] = useState(false);
  const [copying, setCopying] = useState(false);

  const applyResponse = useCallback((data: SlidesApiResponse) => {
    setDoc(data.slides ?? emptySlideDocument());
    setHasBurnedSlides(!!data.hasBurnedSlides);
    setHasMaster(!!data.hasMaster);
    setBurnStatus(data.burnStatus ?? null);
    setBurnError(data.burnError ?? null);
    setBurnDisk(
      data.burnMasterBytes != null || data.burnPeakDiskBytes != null
        ? { masterBytes: data.burnMasterBytes ?? null, peakBytes: data.burnPeakDiskBytes ?? null }
        : null,
    );
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
        // The editor stays open and confirms the save itself (see SlideEditor).
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

  const generateDefaults = useCallback(
    async (lang: SlideLanguage): Promise<GeneratedSlides | null> => {
      setGenerating(true);
      try {
        return await requestDefaultSlides(`/api/admin/videos/${videoId}/slides/defaults`, { lang });
      } catch (err) {
        notify(generationErrorMessage(err, translate), { type: "error" });
        return null;
      } finally {
        setGenerating(false);
      }
    },
    [videoId, notify, translate],
  );

  const reburn = useCallback(async (): Promise<boolean> => {
    setReburning(true);
    try {
      const res = await authFetch(`/api/admin/videos/${videoId}/reburn`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
      }
      notify("padmakara.slides.burnQueued", { type: "success" });
      await fetchData();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify("padmakara.slides.burnFailed", { type: "error", messageArgs: { error: msg } });
      await fetchData();
      return false;
    } finally {
      setReburning(false);
    }
  }, [videoId, notify, fetchData]);

  const copyFrom = useCallback(
    async (sourceVideoId: number): Promise<CopiedSlides | null> => {
      setCopying(true);
      try {
        const res = await authFetch(`/api/admin/videos/${videoId}/slides/copy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceVideoId }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as CopiedSlides;
      } catch (err) {
        notify(
          `${translate("padmakara.slides.copyFailed", { _: "Could not copy slides" })}: ${err instanceof Error ? err.message : String(err)}`,
          { type: "error" },
        );
        return null;
      } finally {
        setCopying(false);
      }
    },
    [videoId, notify, translate],
  );

  return { loading, doc, hasBurnedSlides, hasMaster, burnStatus, burnError, burnDisk, saving, reburning, generating, copying, copyFrom, save, generateDefaults, reburn, refresh: fetchData };
}

/* ───────── Copy slides from another video ───────── */

/** How a copy handled the session slide; mirrors src/lib/slides/copy.ts. */
export type SessionSlideOutcome = "flagged" | "unknown";

export interface CopiedSlides {
  slides: SlideDocument;
  sessionSlide: SessionSlideOutcome;
}

export interface CopySource {
  id: number;
  label: string;
}

/** What the last generation, copy or session change has to tell the admin, until dismissed. */
type EditorNotice =
  | { kind: "generation"; missing: MissingSlideInput[] }
  | { kind: "copy"; outcome: SessionSlideOutcome }
  | { kind: "session" }
  | { kind: "saved" };

/* ───────── The editor dialog itself ───────── */

export interface PendingUploadSlides {
  slides: SlideDocument | null;
  hasBurnedSlides: boolean;
  /** The session the finished file belongs to, when known. */
  sessionId?: number | null;
}

export interface SlideEditorProps {
  open: boolean;
  onClose: () => void;
  title: string;
  videoId: number;
  initialDocument: SlideDocument;
  onSave: (doc: SlideDocument) => Promise<boolean | void> | boolean | void;
  saving?: boolean;
  onGenerateDefaults: (lang: SlideLanguage) => Promise<GeneratedSlides | null>;
  generating?: boolean;
  /** Other videos of the event that have slides, for "Copy from another video". */
  copySources: CopySource[];
  onCopyFrom: (sourceVideoId: number) => Promise<CopiedSlides | null>;
  copying?: boolean;
  /** The event's sessions, the video's own, and the change handler. */
  sessions: SessionOption[];
  sessionId: number | null;
  onChangeSession: (sessionId: number | null) => Promise<void> | void;
  /** True when the row has a file (a master or a Bunny video). */
  videoUploaded: boolean;
  onUploadVideo?: () => void;
  /** Progress of the file being uploaded into this video, owned by the page that runs the upload. */
  videoUpload?: VideoUploadState | null;
  onCancelUpload?: () => void;
  burnStatus?: string | null;
  burnError?: string | null;
  burnDisk?: BurnDisk | null;
  hasMaster?: boolean;
  reburning?: boolean;
  onReburn?: () => void | Promise<unknown>;
}

interface Selection {
  sequence: SlideSequenceKey;
  slideId: string | null;
}

/** Text of the notice shown under the header. */
function noticeText(notice: EditorNotice, translate: Translate): string | null {
  switch (notice.kind) {
    case "generation":
      return generationNoticeText(notice.missing, translate);
    case "copy":
      if (notice.outcome === "flagged") {
        return translate("padmakara.slides.copyFlagged", {
          _: "Slides copied. The session slide is marked: check its session number and date before saving.",
        });
      }
      return translate("padmakara.slides.copyUnknown", {
        _: "Slides copied as they are. The source has no marked session slide, so check the session slide before saving.",
      });
    case "session":
      return translate("padmakara.slides.sessionChanged", {
        _: "Session changed. Generate the slides again or check the session slide.",
      });
    case "saved":
      return translate("padmakara.slides.saved", { _: "Slides saved" });
  }
}

export const SlideEditor = ({
  open,
  onClose,
  title,
  videoId,
  initialDocument,
  onSave,
  saving,
  onGenerateDefaults,
  generating,
  copySources,
  onCopyFrom,
  copying,
  sessions,
  sessionId,
  onChangeSession,
  videoUploaded,
  onUploadVideo,
  videoUpload,
  onCancelUpload,
  burnStatus,
  burnError,
  burnDisk,
  hasMaster,
  reburning,
  onReburn,
}: SlideEditorProps) => {
  const translate = useTranslate();
  const [doc, setDoc] = useState<SlideDocument>(initialDocument);
  const [baseline, setBaseline] = useState<SlideDocument>(initialDocument);
  const [selection, setSelection] = useState<Selection>({ sequence: "intro", slideId: initialDocument.intro[0]?.id ?? null });
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [marks, setMarks] = useState<Record<CanvasMark, boolean>>({ bold: false, italic: false });
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const [slidesLanguage, setSlidesLanguage] = useState<SlideLanguage>("en");
  const [localSaving, setLocalSaving] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [generateAnchor, setGenerateAnchor] = useState<HTMLElement | null>(null);
  const [copyAnchor, setCopyAnchor] = useState<HTMLElement | null>(null);
  const [sessionAnchor, setSessionAnchor] = useState<HTMLElement | null>(null);
  const canvasRef = useRef<SlideCanvasHandle | null>(null);
  // Presigned GET URLs for image s3Keys of an already-saved document.
  const remoteUrls = useRef<Map<string, string>>(new Map());
  const [, forceRerender] = useReducer((c: number) => c + 1, 0);

  // Re-seed from the caller's document whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setDoc(initialDocument);
    setBaseline(initialDocument);
    setSelection({ sequence: "intro", slideId: initialDocument.intro[0]?.id ?? null });
    setSelectedLineId(null);
    setNotice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Resolve saved image lines (neither builtin nor empty) to presigned URLs in
  // one batched call, so the slide can show an image uploaded earlier.
  useEffect(() => {
    if (!open) return;
    const keys = new Set<string>();
    for (const slides of [initialDocument.intro, initialDocument.outro]) {
      for (const s of slides) {
        for (const line of s.lines) {
          if (line.type === "image" && line.s3Key && !isBuiltinKey(line.s3Key)) keys.add(line.s3Key);
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
        for (const [key, url] of Object.entries(data.urls)) remoteUrls.current.set(key, url);
        if (!cancelled) forceRerender();
      } catch {
        // Silent: the affected images stay unresolved instead of crashing the dialog.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, videoId, initialDocument]);

  const resolveImageUrl = useCallback((key: string): string => {
    if (!key) return TRANSPARENT_PIXEL;
    if (isBuiltinKey(key)) return `/images/${builtinFilename(key)}`;
    return remoteUrls.current.get(key) ?? TRANSPARENT_PIXEL;
  }, []);
  const resolveClipUrl = useCallback((clip: BuiltinClipId): string => `/images/${BUILTIN_CLIPS[clip].filename}`, []);

  // What counts as saved: the document the dialog opened with, then whatever was last saved.
  const dirty = useMemo(() => JSON.stringify(doc) !== JSON.stringify(baseline), [doc, baseline]);

  // The "saved" confirmation fades after a moment; other notices stay until dismissed.
  useEffect(() => {
    if (notice?.kind !== "saved") return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  // The selection can point at a slide that was deleted or replaced; fall back to the first one.
  const sequenceSlides = doc[selection.sequence];
  const selectedSlide: Slide | null =
    sequenceSlides.find((s) => s.id === selection.slideId) ?? sequenceSlides[0] ?? null;
  const selectedSlideId = selectedSlide?.id ?? null;
  const selectedLine = selectedSlide?.lines.find((l) => l.id === selectedLineId) ?? null;
  const isClip = !!selectedSlide && isClipSlide(selectedSlide);

  const subtitleLang = introSubtitleLanguage(doc, slidesLanguage);
  const session = sessions.find((s) => s.id === sessionId) ?? null;

  const select = (sequence: SlideSequenceKey, slideId: string | null) => {
    setSelection({ sequence, slideId });
    setSelectedLineId(null);
  };

  const replaceDocument = (next: SlideDocument) => {
    setDoc(next);
    if (next.intro.length > 0 || next.outro.length === 0) select("intro", next.intro[0]?.id ?? null);
    else select("outro", next.outro[0]?.id ?? null);
  };

  const handleAddSlide = (sequence: SlideSequenceKey) => {
    const next = addSlide(doc, sequence);
    setDoc(next);
    select(sequence, next[sequence][next[sequence].length - 1]?.id ?? null);
  };

  const handleDeleteSlide = () => {
    if (!selectedSlide) return;
    const { sequence } = selection;
    const index = doc[sequence].findIndex((s) => s.id === selectedSlide.id);
    const next = deleteSlide(doc, sequence, selectedSlide.id);
    setDoc(next);
    select(sequence, next[sequence][Math.min(index, next[sequence].length - 1)]?.id ?? null);
  };

  const handleDuplicateSlide = () => {
    if (!selectedSlide) return;
    const { sequence } = selection;
    const index = doc[sequence].findIndex((s) => s.id === selectedSlide.id);
    const next = duplicateSlide(doc, sequence, selectedSlide.id);
    setDoc(next);
    select(sequence, next[sequence][index + 1]?.id ?? null);
  };

  const handleMoveSlide = (direction: -1 | 1) => {
    if (!selectedSlide) return;
    setDoc((d) => moveSlide(d, selection.sequence, selectedSlide.id, direction));
  };

  const handleSpans = (lineId: string, spans: Span[]) => {
    if (!selectedSlideId) return;
    const line = selectedSlide?.lines.find((l) => l.id === lineId);
    if (!line || line.type !== "text") return;
    setDoc((d) => replaceLine(d, selection.sequence, selectedSlideId, lineId, { ...line, spans }));
  };

  const patchSelectedText = (patch: Partial<Pick<TextLine, "size" | "dim" | "smallCaps">>) => {
    if (!selectedSlideId || !selectedLineId) return;
    setDoc((d) => patchTextLine(d, selection.sequence, selectedSlideId, selectedLineId, patch));
  };

  const handleAddLine = (kind: "text" | "space") => {
    if (!selectedSlideId) return;
    const line = kind === "text" ? newTextLine() : newSpacerLine();
    setDoc((d) => addLine(d, selection.sequence, selectedSlideId, line));
    setSelectedLineId(line.id);
  };

  const handleDeleteLine = () => {
    if (!selectedSlideId || !selectedLineId) return;
    setDoc((d) => deleteLine(d, selection.sequence, selectedSlideId, selectedLineId));
    setSelectedLineId(null);
  };

  const confirmReplace = (): boolean =>
    !hasAnySlides(doc) ||
    window.confirm(
      translate("padmakara.slides.generateConfirm", {
        _: "This replaces the current slides with a template generated from the event's data. Continue?",
      }),
    );

  const handleGenerate = async (lang: SlideLanguage) => {
    setGenerateAnchor(null);
    if (!confirmReplace()) return;
    const generated = await onGenerateDefaults(lang);
    if (!generated) return;
    replaceDocument(generated.slides);
    setSlidesLanguage(generated.language);
    setNotice({ kind: "generation", missing: generated.missing });
  };

  const handleCopy = async (sourceId: number) => {
    setCopyAnchor(null);
    if (
      hasAnySlides(doc) &&
      !window.confirm(
        translate("padmakara.slides.copyConfirm", { _: "This replaces the current slides with the other video's. Continue?" }),
      )
    ) {
      return;
    }
    const copied = await onCopyFrom(sourceId);
    if (!copied) return;
    replaceDocument(copied.slides);
    setNotice({ kind: "copy", outcome: copied.sessionSlide });
  };

  const handleChangeSession = async (next: number) => {
    setSessionAnchor(null);
    if (next === sessionId) return;
    await onChangeSession(next);
    setNotice({ kind: "session" });
  };

  const handleSave = async () => {
    setLocalSaving(true);
    try {
      const result = await onSave(doc);
      if (result !== false) {
        setBaseline(doc);
        setNotice({ kind: "saved" });
      }
    } finally {
      setLocalSaving(false);
    }
  };

  const handleRequestClose = () => {
    if (
      dirty &&
      !window.confirm(translate("padmakara.slides.unsavedConfirm", { _: "Discard unsaved changes to the slides?" }))
    ) {
      return;
    }
    onClose();
  };

  const isSaving = saving ?? localSaving;
  const noticeMessage = notice ? noticeText(notice, translate) : null;
  const busy = !!generating || !!copying;
  const languageName = (lang: SlideLanguage) =>
    lang === "pt"
      ? translate("padmakara.slides.languagePortuguese", { _: "Portuguese" })
      : translate("padmakara.slides.languageEnglish", { _: "English" });

  return (
    <Dialog open={open} onClose={handleRequestClose} fullScreen>
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%", color: slideEditorTokens.ink }}>
        <Box
          component="header"
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            px: 2.5,
            py: 1.25,
            borderBottom: `1px solid ${slideEditorTokens.border}`,
          }}
        >
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" component="h2" noWrap sx={{ fontWeight: 600, fontSize: "1.05rem", color: slideEditorTokens.ink }}>
              {title}
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, fontSize: "0.8rem", color: slideEditorTokens.muted }}>
              <span>
                {session
                  ? sessionLabel(session, sessions)
                  : translate("padmakara.slides.noSession", { _: "No session chosen" })}
              </span>
              {sessions.length > 0 && (
                <Button
                  size="small"
                  onClick={(e) => setSessionAnchor(e.currentTarget)}
                  aria-haspopup="menu"
                  sx={{ minWidth: 0, py: 0, px: 0.5, fontSize: "0.8rem", color: "primary.main" }}
                >
                  {translate("padmakara.slides.changeSession", { _: "Change" })}
                </Button>
              )}
              <Menu anchorEl={sessionAnchor} open={!!sessionAnchor} onClose={() => setSessionAnchor(null)}>
                {[...sessions]
                  .sort((a, b) => a.sessionNumber - b.sessionNumber)
                  .map((s) => (
                    <MenuItem key={s.id} selected={s.id === sessionId} onClick={() => void handleChangeSession(s.id)}>
                      {sessionLabel(s, sessions)}
                    </MenuItem>
                  ))}
              </Menu>
            </Box>
          </Box>

          <Button
            size="small"
            startIcon={copying ? <CircularProgress size={14} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
            disabled={copySources.length === 0 || busy}
            onClick={(e) => setCopyAnchor(e.currentTarget)}
            aria-haspopup="menu"
            sx={{ color: slideEditorTokens.ink }}
          >
            {translate("padmakara.slides.copyFromVideo", { _: "Copy from another video" })}
          </Button>
          <Menu anchorEl={copyAnchor} open={!!copyAnchor} onClose={() => setCopyAnchor(null)}>
            {copySources.map((source) => (
              <MenuItem key={source.id} onClick={() => void handleCopy(source.id)}>
                {source.label}
              </MenuItem>
            ))}
          </Menu>

          <Button
            size="small"
            startIcon={generating ? <CircularProgress size={14} /> : <AutoAwesomeIcon sx={{ fontSize: 16 }} />}
            endIcon={<KeyboardArrowDownIcon sx={{ fontSize: 16 }} />}
            disabled={busy}
            onClick={(e) => setGenerateAnchor(e.currentTarget)}
            aria-haspopup="menu"
            sx={{ color: slideEditorTokens.ink }}
          >
            {translate("padmakara.slides.generateIn", { language: languageName(slidesLanguage), _: `Generate in ${languageName(slidesLanguage)}` })}
          </Button>
          <Menu anchorEl={generateAnchor} open={!!generateAnchor} onClose={() => setGenerateAnchor(null)}>
            {(["en", "pt"] as const).map((lang) => (
              <MenuItem key={lang} onClick={() => void handleGenerate(lang)}>
                {languageName(lang)}
              </MenuItem>
            ))}
          </Menu>

          <Button
            variant="contained"
            disableElevation
            disabled={!dirty || isSaving}
            startIcon={isSaving ? <CircularProgress size={14} color="inherit" /> : undefined}
            onClick={() => void handleSave()}
          >
            {translate("padmakara.slides.saveSlides", { _: "Save slides" })}
          </Button>
          <IconButton onClick={handleRequestClose} aria-label={translate("padmakara.slides.close", { _: "Close" })}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>

        {busy && (
          <Alert severity="info" icon={<CircularProgress size={16} />} sx={{ mx: 2.5, mt: 1.5 }}>
            {generating
              ? translate("padmakara.slides.generating", { _: "Generating slides from the event data…" })
              : translate("padmakara.slides.copying", { _: "Copying slides…" })}
          </Alert>
        )}
        {!busy && notice && noticeMessage && (
          <Alert
            severity={
              notice.kind === "saved"
                ? "success"
                : notice.kind === "generation" && nothingToGenerateFrom(notice.missing)
                  ? "warning"
                  : "info"
            }
            onClose={() => setNotice(null)}
            sx={{ mx: 2.5, mt: 1.5 }}
          >
            {noticeMessage}
          </Alert>
        )}

        <Box sx={{ flex: 1, minHeight: 0, display: "flex", mt: 1.5, borderTop: `1px solid ${slideEditorTokens.border}` }}>
          <SlideSequenceList
            intro={doc.intro}
            outro={doc.outro}
            selection={{ sequence: selection.sequence, slideId: selectedSlideId }}
            resolveImageUrl={resolveImageUrl}
            onSelect={select}
            onAdd={handleAddSlide}
            onAddLogo={
              hasLogoClip(doc)
                ? undefined
                : () => {
                    const next = addLogoClip(doc);
                    setDoc(next);
                    select("intro", next.intro[0]?.id ?? null);
                  }
            }
            video={{
              state: videoBlockState({ hasFile: videoUploaded, burnStatus: burnStatus ?? null }),
              burnStatus: burnStatus ?? null,
              burnError: burnError ?? null,
              burnDisk: burnDisk ?? null,
              hasMaster: !!hasMaster,
              slideCount: initialDocument.intro.length + initialDocument.outro.length,
              reburning: !!reburning,
              onReburn: onReburn ?? (() => undefined),
              onUploadVideo,
              upload: videoUpload ?? null,
              onCancelUpload,
            }}
          />

          <Box
            component="main"
            sx={{
              flex: 1,
              minWidth: 0,
              overflowY: "auto",
              backgroundColor: slideEditorTokens.ground,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 2,
              p: 3,
            }}
          >
            {!isClip && selectedSlide && (
              <SlideLineToolbar
                line={selectedLine}
                marks={marks}
                onSize={(size: LineSize) => patchSelectedText({ size })}
                onMark={(mark) => canvasRef.current?.applyMark(mark)}
                onToggleSmallCaps={() =>
                  patchSelectedText({ smallCaps: selectedLine?.type === "text" ? !selectedLine.smallCaps : undefined })
                }
                onToggleDim={() => patchSelectedText({ dim: selectedLine?.type === "text" ? !selectedLine.dim : undefined })}
                onDelete={handleDeleteLine}
              />
            )}

            <Box sx={{ width: "100%", maxWidth: 760 }}>
              <SlideCanvas
                ref={canvasRef}
                slide={selectedSlide}
                selectedLineId={selectedLineId}
                onSelectLine={setSelectedLineId}
                onChangeSpans={handleSpans}
                onMarksChange={setMarks}
                resolveImageUrl={resolveImageUrl}
                resolveClipUrl={resolveClipUrl}
                emptyLabel={translate("padmakara.slides.empty", { _: "No slides yet" })}
                frameLabel={translate("padmakara.slides.canvasLabel", { _: "Selected slide" })}
              />
            </Box>

            <Box sx={{ width: "100%", maxWidth: 760, display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
              <Box sx={{ flex: 1, minWidth: 220, fontSize: "0.78rem", color: slideEditorTokens.muted }}>
                {!isClip &&
                  translate("padmakara.slides.canvasHint", {
                    _: "Click any text on the slide to edit it. Enter starts a new line.",
                  })}
              </Box>
              {!isClip && selectedSlide && (
                <>
                  <Button size="small" onClick={() => handleAddLine("text")} sx={{ color: "primary.main" }}>
                    {translate("padmakara.slides.addText", { _: "+ Add text" })}
                  </Button>
                  <Button size="small" onClick={() => handleAddLine("space")} sx={{ color: "primary.main" }}>
                    {translate("padmakara.slides.addSpace", { _: "+ Add space" })}
                  </Button>
                </>
              )}
              <Button
                size="small"
                variant="outlined"
                disabled={doc.intro.length === 0}
                startIcon={<PlayArrowIcon sx={{ fontSize: 16 }} />}
                onClick={() => setPlaying(true)}
              >
                {translate("padmakara.slides.playIntro", { _: "Play intro" })}
              </Button>
            </Box>
            <Box sx={{ fontSize: "0.72rem", color: slideEditorTokens.muted }}>
              {`${translate("padmakara.slides.totalLength", { _: "Slides total" })}: ${formatClock(documentDurationMs(doc))}`}
            </Box>
          </Box>

          <SlideInspector
            slide={selectedSlide}
            subtitleLang={selection.sequence === "intro" ? subtitleLang : undefined}
            onTiming={(patch) => selectedSlideId && setDoc((d) => updateSlide(d, selection.sequence, selectedSlideId, patch))}
            onSubtitle={(patch) => selectedSlideId && setDoc((d) => updateSlide(d, selection.sequence, selectedSlideId, patch))}
            onMove={handleMoveSlide}
            canMoveUp={!!selectedSlide && sequenceSlides.findIndex((s) => s.id === selectedSlide.id) > 0}
            canMoveDown={
              !!selectedSlide && sequenceSlides.findIndex((s) => s.id === selectedSlide.id) < sequenceSlides.length - 1
            }
            onDuplicate={handleDuplicateSlide}
            onDelete={handleDeleteSlide}
            onMarkReviewed={() => selectedSlideId && setDoc((d) => markSlideReviewed(d, selection.sequence, selectedSlideId))}
          />
        </Box>
      </Box>

      <Dialog open={playing} onClose={() => setPlaying(false)} maxWidth="md" fullWidth>
        <Box sx={{ p: 2 }}>
          <SlideEditorPreview
            slides={doc.intro}
            selectedIndex={0}
            onSelectIndex={() => undefined}
            resolveImageUrl={resolveImageUrl}
            resolveClipUrl={resolveClipUrl}
            autoPlay
          />
          <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 1 }}>
            <Button color="inherit" onClick={() => setPlaying(false)}>
              {translate("padmakara.slides.close", { _: "Close" })}
            </Button>
          </Box>
        </Box>
      </Dialog>
    </Dialog>
  );
};
