/**
 * SessionTrackTable — one shared editable table for tracks grouped into
 * sessions, used by both import flows (folder-upload EventCreate and the
 * legacy Migration screen). It is fully controlled: it operates on a neutral
 * `TableValue`; each screen bridges its own model with thin adapters keyed by
 * a stable per-track `key`.
 *
 * Performance design — edits update one track among ~200 without re-rendering
 * the other 199:
 *   - `valueRef` + `onChangeRef` make per-row callbacks referentially stable
 *     (empty-deps `useCallback`) so they never invalidate `memo`.
 *   - Edits use *path-shallow* immutable updates — only the affected session
 *     and the affected track get new object identities; every other track
 *     keeps its reference.
 *   - `ReadonlyTrackRow` is `memo()`-wrapped, so a track whose props are
 *     reference-equal to the previous render is skipped entirely; the heavy
 *     `EditingTrackRow` is only ever mounted for the one track being edited.
 *   - This only pays off when the parent feeds the table identity-stable
 *     props — see the adapters on each screen, which cache per source track.
 */

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Select from "@mui/material/Select";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Checkbox from "@mui/material/Checkbox";
import Collapse from "@mui/material/Collapse";
import InputBase from "@mui/material/InputBase";
import Tooltip from "@mui/material/Tooltip";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import SelfImprovementIcon from "@mui/icons-material/SelfImprovement";
import TranslateIcon from "@mui/icons-material/Translate";
import { useNotify, useTranslate } from "react-admin";
import { translateFields, type TranslateDirection } from "../utils/translateFields";
import { SpeakerChipPicker } from "./SpeakerPicker";
import { AiReviewChip, TranslateDirChip, useFieldTranslate } from "./TranslatableField";
import {
  DEFAULT_LANG_CHIP,
  LANG_CHIP_COLORS,
  LANGUAGE_CODES,
  LangTag,
  clickToEditSx,
  quietInputSx,
  toggleChipSx,
} from "./inlineEditKit";
import { languageLabel } from "../utils/trackParser";
import type { TrackCorrection } from "../utils/analyzeFolder";

/** Map keyed by a track's stable key → list of corrections applied to it. */
export type TrackCorrectionsMap = Map<string, TrackCorrection[]>;

export function correctionFieldLabel(field: TrackCorrection["field"]): string {
  return field === "title" ? "Title" : "Filename";
}

export function correctionKindLabel(kind: TrackCorrection["kind"]): string {
  switch (kind) {
    case "accents":
      return "Accents added";
    case "spelling":
      return "Spelling fixed";
    case "capitalization":
      return "Capitalization";
    case "rename":
      return "Renamed";
  }
}

/**
 * A track as the table edits it — no File / no importFileId; those stay in
 * the screen's own model and are re-merged by `key`.
 */
export interface TableTrack {
  /** Stable identity within this table (survives edits and moves). */
  key: string;
  /** Editable filename that will become the S3 key on upload. */
  uploadFilename: string;
  trackNumber: number;
  title: string;
  titleEn: string;
  titlePt: string;
  titleEnReviewed: boolean;
  titlePtReviewed: boolean;
  speaker: string | null;
  languages: string[];
  originalLanguage: string;
  isTranslation: boolean;
  isPractice: boolean;
}

export interface TableSession {
  titleEn: string;
  titlePt: string;
  titleEnReviewed: boolean;
  titlePtReviewed: boolean;
  sessionDate: string | null;
  timePeriod: string | null;
  tracks: TableTrack[];
}

/** The full editable value. `ignored` is `[]` for screens that don't use it. */
export interface TableValue {
  sessions: TableSession[];
  ignored: TableTrack[];
}

const TIME_PERIODS = ["morning", "afternoon"];
const LANGUAGE_OPTIONS = [
  { value: "en", label: "EN" },
  { value: "pt", label: "PT" },
  { value: "tib", label: "TIB" },
  { value: "fr", label: "FR" },
];
// Canonical order so a multi-language selection is stable regardless of click
// order, and `originalLanguage` (the first entry) is the source language
// (tib < en < pt < fr) — matching the backend parser.
const LANG_PRIORITY: Record<string, number> = { tib: 0, en: 1, pt: 2, fr: 3 };
const sortLanguages = (langs: string[]): string[] =>
  [...langs].sort((a, b) => (LANG_PRIORITY[a] ?? 9) - (LANG_PRIORITY[b] ?? 9));
const formatLanguages = (langs: string[]): string =>
  (langs.length ? langs : ["en"]).map((l) => l.toUpperCase()).join("+");

type Teacher = { id: number; name: string; abbreviation: string };

interface SessionTrackTableProps {
  value: TableValue;
  onChange: (next: TableValue) => void;
  /** DB teachers — populate the per-track speaker combobox. */
  teachers: Teacher[];
  /** Show the per-track "ignore" action + the restorable ignored section. */
  enableIgnore?: boolean;
  /** Show the per-track "practice" checkbox column. */
  enablePractice?: boolean;
  /** Allow editing each track's filename (the future S3 key). Only safe
   *  pre-upload (EventCreate); the migration flow's files already live on S3,
   *  so it leaves this off and shows the filename read-only. */
  editableFilename?: boolean;
  /** When provided, tracks whose `key` matches get an AI-correction badge
   *  with a tooltip listing the diffs. */
  trackCorrections?: TrackCorrectionsMap;
}

/** Resolve a stored speaker abbreviation to the teacher's full name for display. */
const teacherDisplayName = (teachers: Teacher[], abbr: string | null): string => {
  if (!abbr) return "";
  return teachers.find((t) => t.abbreviation === abbr)?.name ?? abbr;
};

/** The ✨ correction badge + rich diff tooltip, shared by both row modes. */
function CorrectionsBadge({ corrections }: { corrections: TrackCorrection[] }) {
  if (corrections.length === 0) return null;
  return (
    <Tooltip
      arrow
      slotProps={{
        tooltip: {
          sx: {
            bgcolor: "background.paper",
            color: "text.primary",
            border: "1px solid",
            borderColor: "divider",
            boxShadow: 4,
            p: 1.5,
            maxWidth: 380,
          },
        },
        arrow: {
          sx: {
            color: "background.paper",
            "&::before": { border: "1px solid", borderColor: "divider" },
          },
        },
      }}
      title={
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
          {corrections.map((c, i) => (
            <Box
              key={i}
              sx={{
                display: "flex",
                flexDirection: "column",
                gap: 0.25,
                pb: i < corrections.length - 1 ? 1.25 : 0,
                borderBottom: i < corrections.length - 1 ? "1px solid" : "none",
                borderColor: "divider",
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 0.25 }}>
                <AutoAwesomeIcon sx={{ fontSize: 13, color: "warning.main" }} />
                <Typography sx={{ fontSize: "0.68rem", fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: "text.secondary" }}>
                  {correctionFieldLabel(c.field)} · {correctionKindLabel(c.kind)}
                </Typography>
              </Box>
              <Typography sx={{ fontSize: "0.8rem", color: "error.main", textDecoration: "line-through" }}>
                {c.before}
              </Typography>
              <Typography sx={{ fontSize: "0.8rem", color: "success.main", fontWeight: 600 }}>
                {c.after}
              </Typography>
            </Box>
          ))}
        </Box>
      }
    >
      <Chip
        icon={<AutoAwesomeIcon />}
        label={String(corrections.length)}
        size="small"
        color="warning"
        variant="outlined"
      />
    </Tooltip>
  );
}

// --- Read-only row (cheap; the table renders these by default) --------------

interface ReadonlyTrackRowProps {
  track: TableTrack;
  teachers: Teacher[];
  enablePractice: boolean;
  corrections?: TrackCorrection[];
  onEdit: (key: string) => void;
}

const ReadonlyTrackRow = memo(function ReadonlyTrackRow({
  track,
  teachers,
  enablePractice,
  corrections,
  onEdit,
}: ReadonlyTrackRowProps) {
  return (
    <Box
      // The open editor is taller than a collapsed row, so if it blurs
      // mid-click everything below it shifts upwards: mouseup then lands on a
      // different element, no click fires, and clicking a row BELOW the editor
      // only closed it. Suppressing mousedown's default keeps focus where it
      // is, so the editor does not blur, nothing reflows, and the click below
      // lands on the row the user actually aimed at. Opening still happens on
      // click — doing it on mousedown instead swaps the DOM before the
      // browser applies its own focus, which blurs the newly autoFocused
      // input straight back out and closes the row on the spot.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onEdit(track.key)}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 2,
        py: 0.75,
        borderBottom: "1px solid rgba(0,0,0,0.04)",
        cursor: "pointer",
        opacity: track.isTranslation ? 0.75 : 1,
        "&:hover": { backgroundColor: "rgba(91,94,166,0.02)" },
      }}
    >
      <Typography
        variant="caption"
        sx={{
          width: 24,
          textAlign: "right",
          color: "text.secondary",
          fontFamily: "monospace",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {String(track.trackNumber).padStart(2, "0")}
      </Typography>
      {/* Title (click-to-edit) + upload filename underneath — the filename is
          the future S3 key, so it stays visible pre-upload. */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          noWrap
          sx={{
            display: "inline-block",
            maxWidth: "100%",
            verticalAlign: "middle",
            fontWeight: track.isTranslation ? 400 : 500,
            ...clickToEditSx,
          }}
        >
          {track.titleEn || track.titlePt || track.title}
        </Typography>
        <Typography
          variant="caption"
          title={track.uploadFilename}
          sx={{
            fontFamily: "monospace",
            fontSize: "0.62rem",
            color: "text.disabled",
            display: "block",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {track.uploadFilename}
        </Typography>
      </Box>
      <CorrectionsBadge corrections={corrections ?? []} />
      {enablePractice && track.isPractice && (
        <Chip
          icon={<SelfImprovementIcon sx={{ fontSize: "12px !important" }} />}
          label="Practice"
          size="small"
          sx={{
            height: 20,
            backgroundColor: "rgba(156,39,176,0.1)",
            color: "#9c27b0",
            "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5, fontWeight: 600 },
            "& .MuiChip-icon": { color: "#9c27b0" },
          }}
        />
      )}
      {track.isTranslation && (
        <Chip
          icon={<TranslateIcon sx={{ fontSize: "12px !important" }} />}
          label="Translation"
          size="small"
          sx={{
            height: 20,
            backgroundColor: "rgba(212,168,83,0.12)",
            color: "#8a6a1f",
            "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5 },
            "& .MuiChip-icon": { color: "#8a6a1f" },
          }}
        />
      )}
      {track.speaker && (
        <Chip
          label={track.speaker}
          title={teacherDisplayName(teachers, track.speaker)}
          size="small"
          variant="outlined"
          sx={{ height: 20, "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5, fontWeight: 600 } }}
        />
      )}
      {(track.languages.length ? track.languages : ["en"]).map((lang) => {
        const lc = LANG_CHIP_COLORS[lang.toLowerCase()] || DEFAULT_LANG_CHIP;
        return (
          <Chip
            key={lang}
            label={languageLabel(lang)}
            size="small"
            sx={{
              height: 20,
              backgroundColor: lc.bg,
              color: lc.text,
              "& .MuiChip-label": { fontSize: "0.65rem", px: 0.5, fontWeight: 600 },
            }}
          />
        );
      })}
    </Box>
  );
});

// --- Editing row (heavy; only one is ever mounted at a time) ----------------

interface EditingTrackRowProps {
  track: TableTrack;
  sessionIdx: number;
  sessionCount: number;
  teachers: Teacher[];
  enableIgnore: boolean;
  enablePractice: boolean;
  onTrackChange: (key: string, patch: Partial<TableTrack>) => void;
  onMoveTrack: (key: string, toSessionIdx: number) => void;
  onIgnoreTrack: (key: string) => void;
  onStopEdit: () => void;
  /** Save this row, then move the editor to the previous/next track. */
  onNavigate: (delta: -1 | 1) => void;
  editableFilename: boolean;
  /** AI corrections to flag on this row (rendered as a Tooltip-equipped chip). */
  corrections?: TrackCorrection[];
  /** True while the table-wide "fill translations" batch is running —
   *  disables this row's translate chips too, so a per-row translate can't
   *  race the bulk fill. */
  bulkBusy?: boolean;
}

/**
 * The same compact inline editor as the edit flow's TrackRow
 * (SessionPreview.tsx): quiet EN/PT title inputs, toggleable metadata chips,
 * Enter/blur saves, Esc discards, ↑/↓ saves and moves to the adjacent track.
 * Edits accumulate in a local draft and are committed as ONE field-diffed
 * patch on close, so a "fill translations" batch landing mid-edit is never
 * clobbered by stale untouched fields.
 */
function EditingTrackRow({
  track,
  sessionIdx,
  sessionCount,
  teachers,
  enableIgnore,
  enablePractice,
  onTrackChange,
  onMoveTrack,
  onIgnoreTrack,
  onStopEdit,
  onNavigate,
  editableFilename,
  corrections,
  bulkBusy,
}: EditingTrackRowProps) {
  const translate = useTranslate();
  const ft = useFieldTranslate();
  const busy = ft.translating || !!bulkBusy;

  // Seed once on mount — the component only mounts while this row is the one
  // being edited.
  const seedRef = useRef<TableTrack>({ ...track, languages: [...track.languages] });
  const seed = seedRef.current;
  const [draft, setDraft] = useState<TableTrack>(seed);
  const [speakerPickerOpen, setSpeakerPickerOpen] = useState(false);
  const [moveMenuAnchor, setMoveMenuAnchor] = useState<null | HTMLElement>(null);
  // Set once the editor's outcome is decided (save, cancel or navigate) so a
  // trailing blur can't double-commit.
  const doneRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const buildPatch = (): Partial<TableTrack> => {
    const patch: Partial<TableTrack> = {};
    if (draft.trackNumber !== seed.trackNumber) patch.trackNumber = draft.trackNumber;
    if (draft.uploadFilename !== seed.uploadFilename) patch.uploadFilename = draft.uploadFilename;
    if (draft.titleEn !== seed.titleEn) patch.titleEn = draft.titleEn;
    if (draft.titlePt !== seed.titlePt) patch.titlePt = draft.titlePt;
    if (draft.titleEnReviewed !== seed.titleEnReviewed) patch.titleEnReviewed = draft.titleEnReviewed;
    if (draft.titlePtReviewed !== seed.titlePtReviewed) patch.titlePtReviewed = draft.titlePtReviewed;
    if (draft.speaker !== seed.speaker) patch.speaker = draft.speaker;
    if (draft.languages.join(",") !== seed.languages.join(",")) {
      patch.languages = draft.languages;
      patch.originalLanguage = draft.languages[0]!;
    }
    if (draft.isTranslation !== seed.isTranslation) patch.isTranslation = draft.isTranslation;
    if (draft.isPractice !== seed.isPractice) patch.isPractice = draft.isPractice;
    return patch;
  };

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    const patch = buildPatch();
    if (Object.keys(patch).length > 0) onTrackChange(track.key, patch);
  };

  // Clicking another row switches `editingKey` on mousedown, which unmounts
  // this editor and can outrun the blur handler. Commit on unmount so a pending
  // draft is never silently dropped; `doneRef` stops this double-saving after
  // an explicit save, cancel or arrow-key navigation, and cancelEdit sets it
  // without committing so Esc still discards.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);

  const saveAndClose = () => {
    commit();
    onStopEdit();
  };

  const cancelEdit = () => {
    doneRef.current = true;
    onStopEdit();
  };

  const saveAndNavigate = (delta: -1 | 1) => {
    commit();
    onNavigate(delta);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveAndClose();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      saveAndNavigate(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      saveAndNavigate(-1);
    }
  };

  const handleContainerBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    // Menus render in portals — focus moving into them must not close the
    // editor.
    if (speakerPickerOpen || moveMenuAnchor) return;
    if (e.relatedTarget && containerRef.current?.contains(e.relatedTarget as Node)) return;
    saveAndClose();
  };

  return (
    <Box
      ref={containerRef}
      onBlur={handleContainerBlur}
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 0.6,
        px: 2,
        py: 1,
        borderBottom: "1px solid rgba(0,0,0,0.04)",
        backgroundColor: "rgba(91,94,166,0.03)",
      }}
    >
      {/* EN title line — with the editable track number at the left */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <InputBase
          type="number"
          value={draft.trackNumber}
          onChange={(e) =>
            setDraft((p) => ({ ...p, trackNumber: Number.parseInt(e.target.value, 10) || 0 }))
          }
          onKeyDown={(e) => {
            // Keep ↑/↓ as number stepping here; Enter/Esc still close.
            if (e.key === "Enter" || e.key === "Escape") handleKeyDown(e);
          }}
          sx={{
            ...quietInputSx,
            flex: "0 0 auto",
            width: 48,
            "& input": { p: 0, textAlign: "right", fontFamily: "monospace", fontSize: "0.75rem" },
          }}
        />
        <LangTag code="en" />
        <InputBase
          autoFocus
          fullWidth
          value={draft.titleEn}
          placeholder={translate("padmakara.events.titleEn")}
          onChange={(e) => setDraft((p) => ({ ...p, titleEn: e.target.value, titleEnReviewed: true }))}
          onKeyDown={handleKeyDown}
          sx={quietInputSx}
        />
        {!draft.titleEnReviewed && (
          <AiReviewChip onClick={() => setDraft((p) => ({ ...p, titleEnReviewed: true }))} />
        )}
        {/* Chip lives on the SOURCE field: this EN text fills the PT sibling. */}
        <TranslateDirChip
          direction="en-to-pt"
          disabled={!draft.titleEn.trim()}
          pending={busy}
          tooltip={translate("padmakara.events.translateToPt")}
          onClick={async () => {
            const out = await ft.translate(draft.titleEn, "en-to-pt");
            if (out != null) setDraft((p) => ({ ...p, titlePt: out, titlePtReviewed: false }));
          }}
        />
      </Box>

      {/* PT title line */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box sx={{ width: 48, flexShrink: 0 }} />
        <LangTag code="pt" />
        <InputBase
          fullWidth
          value={draft.titlePt}
          placeholder={translate("padmakara.events.titlePt")}
          onChange={(e) => setDraft((p) => ({ ...p, titlePt: e.target.value, titlePtReviewed: true }))}
          onKeyDown={handleKeyDown}
          sx={quietInputSx}
        />
        {!draft.titlePtReviewed && (
          <AiReviewChip onClick={() => setDraft((p) => ({ ...p, titlePtReviewed: true }))} />
        )}
        <TranslateDirChip
          direction="pt-to-en"
          disabled={!draft.titlePt.trim()}
          pending={busy}
          tooltip={translate("padmakara.events.translateToEn")}
          onClick={async () => {
            const out = await ft.translate(draft.titlePt, "pt-to-en");
            if (out != null) setDraft((p) => ({ ...p, titleEn: out, titleEnReviewed: false }));
          }}
        />
      </Box>

      {/* Upload filename — the future S3 key; editable only pre-upload. */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box sx={{ width: 48, flexShrink: 0 }} />
        <Typography variant="caption" sx={{ color: "text.disabled", flexShrink: 0 }}>
          file:
        </Typography>
        {editableFilename ? (
          <InputBase
            fullWidth
            value={draft.uploadFilename}
            title={draft.uploadFilename}
            onChange={(e) => setDraft((p) => ({ ...p, uploadFilename: e.target.value }))}
            onKeyDown={handleKeyDown}
            sx={{
              ...quietInputSx,
              "& input": { p: 0, fontFamily: "monospace", fontSize: "0.7rem", color: "text.secondary" },
            }}
          />
        ) : (
          <Typography
            variant="caption"
            title={draft.uploadFilename}
            sx={{
              fontFamily: "monospace",
              fontSize: "0.7rem",
              color: "text.secondary",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {draft.uploadFilename}
          </Typography>
        )}
        <CorrectionsBadge corrections={corrections ?? []} />
      </Box>

      {/* Metadata line — the same chips as view mode, made toggleable */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap", pl: "58px" }}>
        <SpeakerChipPicker
          value={draft.speaker}
          teachers={teachers}
          onChange={(abbr) => setDraft((p) => ({ ...p, speaker: abbr }))}
          onOpenChange={setSpeakerPickerOpen}
        />

        {LANGUAGE_CODES.map((lang) => {
          const active = draft.languages.includes(lang);
          const lc = LANG_CHIP_COLORS[lang] || DEFAULT_LANG_CHIP;
          return (
            <Chip
              key={lang}
              size="small"
              label={languageLabel(lang)}
              onClick={() =>
                setDraft((p) => {
                  const has = p.languages.includes(lang);
                  // Keep at least one language selected; keep canonical order
                  // so originalLanguage (the first) is the source language.
                  if (has && p.languages.length === 1) return p;
                  const langs = sortLanguages(
                    has ? p.languages.filter((l) => l !== lang) : [...p.languages, lang],
                  );
                  return { ...p, languages: langs, originalLanguage: langs[0]! };
                })
              }
              sx={toggleChipSx(active, lc)}
            />
          );
        })}

        <Chip
          size="small"
          icon={<TranslateIcon sx={{ fontSize: "12px !important" }} />}
          label="Translation"
          onClick={() => setDraft((p) => ({ ...p, isTranslation: !p.isTranslation }))}
          sx={toggleChipSx(draft.isTranslation, { bg: "rgba(212,168,83,0.12)", text: "#8a6a1f" })}
        />
        {enablePractice && (
          <Chip
            size="small"
            icon={<SelfImprovementIcon sx={{ fontSize: "12px !important" }} />}
            label="Practice"
            onClick={() => setDraft((p) => ({ ...p, isPractice: !p.isPractice }))}
            sx={toggleChipSx(draft.isPractice, { bg: "rgba(156,39,176,0.1)", text: "#9c27b0" })}
          />
        )}

        {sessionCount > 1 && (
          <>
            <Chip
              size="small"
              variant="outlined"
              label={`→ Session ▾`}
              onClick={(e) => setMoveMenuAnchor(e.currentTarget)}
              sx={{ height: 20, fontWeight: 600, "& .MuiChip-label": { px: 0.75, fontSize: "0.65rem" } }}
            />
            <Menu
              anchorEl={moveMenuAnchor}
              open={Boolean(moveMenuAnchor)}
              onClose={() => setMoveMenuAnchor(null)}
            >
              {Array.from({ length: sessionCount }, (_, i) => (
                <MenuItem
                  key={i}
                  disabled={i === sessionIdx}
                  onClick={() => {
                    setMoveMenuAnchor(null);
                    commit();
                    onMoveTrack(track.key, i);
                    onStopEdit();
                  }}
                >
                  {i === sessionIdx ? `Session ${i + 1} (current)` : `Session ${i + 1}`}
                </MenuItem>
              ))}
            </Menu>
          </>
        )}
        {enableIgnore && (
          <Button
            size="small"
            color="warning"
            onClick={() => {
              commit();
              onIgnoreTrack(track.key);
              onStopEdit();
            }}
            sx={{ textTransform: "none", fontSize: "0.7rem", py: 0 }}
          >
            Ignore
          </Button>
        )}

        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" sx={{ color: "text.disabled", fontSize: "0.65rem" }}>
          {translate("padmakara.tracks.editKeyHint")}
        </Typography>
      </Box>
    </Box>
  );
}


// --- Session title (click-to-edit, mirrors SessionCard in SessionPreview) ----

interface SessionTitleBlockProps {
  session: TableSession;
  sIdx: number;
  onSessionChange: (sessionIdx: number, patch: Partial<TableSession>) => void;
}

/**
 * Click-to-edit EN/PT session title, mirroring the edit-flow equivalent in
 * `SessionCard` (SessionPreview.tsx): the title reads as plain text until
 * clicked, then two quiet inputs open in place. Enter/blur saves (dirty
 * fields only), Esc discards.
 */
function SessionTitleBlock({ session, sIdx, onSessionChange }: SessionTitleBlockProps) {
  const translate = useTranslate();
  const ft = useFieldTranslate();
  const [editing, setEditing] = useState(false);
  const seedFromSession = () => ({
    titleEn: session.titleEn,
    titlePt: session.titlePt,
    titleEnReviewed: session.titleEnReviewed,
    titlePtReviewed: session.titlePtReviewed,
  });
  const [draft, setDraft] = useState(seedFromSession);
  const doneRef = useRef(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const openEditor = () => {
    setDraft(seedFromSession());
    doneRef.current = false;
    setEditing(true);
  };

  const save = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    const patch: Partial<TableSession> = {};
    if (draft.titleEn !== session.titleEn) patch.titleEn = draft.titleEn;
    if (draft.titlePt !== session.titlePt) patch.titlePt = draft.titlePt;
    if (draft.titleEnReviewed !== session.titleEnReviewed) patch.titleEnReviewed = draft.titleEnReviewed;
    if (draft.titlePtReviewed !== session.titlePtReviewed) patch.titlePtReviewed = draft.titlePtReviewed;
    if (Object.keys(patch).length > 0) onSessionChange(sIdx, patch);
    setEditing(false);
  };

  const cancel = () => {
    doneRef.current = true;
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget && boxRef.current?.contains(e.relatedTarget as Node)) return;
    save();
  };

  if (!editing) {
    return (
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          noWrap
          title={translate("padmakara.tracks.clickToEdit")}
          onClick={openEditor}
          sx={{
            fontWeight: 600,
            display: "inline-block",
            maxWidth: "100%",
            verticalAlign: "middle",
            ...clickToEditSx,
          }}
        >
          {session.titleEn || session.titlePt || `Session ${sIdx + 1}`}
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      ref={boxRef}
      onBlur={handleBlur}
      sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.5 }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <LangTag code="en" />
        <InputBase
          autoFocus
          fullWidth
          value={draft.titleEn}
          placeholder={translate("padmakara.events.titleEn")}
          onChange={(e) => setDraft((p) => ({ ...p, titleEn: e.target.value, titleEnReviewed: true }))}
          onKeyDown={handleKeyDown}
          sx={quietInputSx}
        />
        {!draft.titleEnReviewed && (
          <AiReviewChip onClick={() => setDraft((p) => ({ ...p, titleEnReviewed: true }))} />
        )}
        {/* Chip lives on the SOURCE field: this EN text fills the PT sibling. */}
        <TranslateDirChip
          direction="en-to-pt"
          disabled={!draft.titleEn.trim()}
          pending={ft.translating}
          tooltip={translate("padmakara.events.translateToPt")}
          onClick={async () => {
            const out = await ft.translate(draft.titleEn, "en-to-pt");
            if (out != null) setDraft((p) => ({ ...p, titlePt: out, titlePtReviewed: false }));
          }}
        />
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <LangTag code="pt" />
        <InputBase
          fullWidth
          value={draft.titlePt}
          placeholder={translate("padmakara.events.titlePt")}
          onChange={(e) => setDraft((p) => ({ ...p, titlePt: e.target.value, titlePtReviewed: true }))}
          onKeyDown={handleKeyDown}
          sx={quietInputSx}
        />
        {!draft.titlePtReviewed && (
          <AiReviewChip onClick={() => setDraft((p) => ({ ...p, titlePtReviewed: true }))} />
        )}
        <TranslateDirChip
          direction="pt-to-en"
          disabled={!draft.titlePt.trim()}
          pending={ft.translating}
          tooltip={translate("padmakara.events.translateToEn")}
          onClick={async () => {
            const out = await ft.translate(draft.titlePt, "pt-to-en");
            if (out != null) setDraft((p) => ({ ...p, titleEn: out, titleEnReviewed: false }));
          }}
        />
      </Box>
    </Box>
  );
}

// --- Main component ---------------------------------------------------------

export function SessionTrackTable({
  value,
  onChange,
  teachers,
  enableIgnore = false,
  enablePractice = false,
  editableFilename = false,
  trackCorrections,
}: SessionTrackTableProps) {
  const notify = useNotify();
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  // Bulk language assignment — most events are uniform (every track TIB+ENG,
  // or every track ENG+PT), so one control sets the languages on all tracks.
  const [bulkLangs, setBulkLangs] = useState<string[]>([]);
  // Busy while the auto-translate bar is filling every empty title in one
  // request — disables the bar's buttons plus (via `bulkBusy` on
  // `EditingTrackRow`) the currently-editing row's own translate chips, so a
  // per-row translate can't race the bulk fill.
  const [tracksBulkBusy, setTracksBulkBusy] = useState(false);
  const translate = useTranslate();

  // Rows are rendered read-only (plain text — cheap) by default; only the row
  // the admin is editing mounts the heavy inputs (Autocomplete, Selects, …).
  // This is what keeps a 50+ track table from freezing the tab on mount: a few
  // hundred light text cells instead of a few hundred MUI input widgets.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const startEdit = useCallback((key: string) => setEditingKey(key), []);
  const stopEdit = useCallback(() => setEditingKey(null), []);

  // The callbacks below are referentially stable (`useCallback([])`); they read
  // the current value/onChange via these refs, so a memo'd TrackRow never
  // invalidates because of a callback identity change.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  /** Move the inline editor to the adjacent track of the same session (the
   *  row commits itself before calling this). Closes at the boundaries. */
  const navigateEdit = useCallback((fromKey: string, delta: -1 | 1) => {
    const v = valueRef.current;
    for (const s of v.sessions) {
      const j = s.tracks.findIndex((t) => t.key === fromKey);
      if (j >= 0) {
        const next = s.tracks[j + delta];
        setEditingKey(next ? next.key : null);
        return;
      }
    }
    setEditingKey(null);
  }, []);

  /** Patch one track by key — only the affected session and track get fresh
   *  object identities; every other track keeps its reference. */
  const onTrackChange = useCallback(
    (key: string, patch: Partial<TableTrack>) => {
      const v = valueRef.current;
      for (let i = 0; i < v.sessions.length; i++) {
        const tracks = v.sessions[i]!.tracks;
        const j = tracks.findIndex((t) => t.key === key);
        if (j >= 0) {
          const next: TableValue = {
            ...v,
            sessions: v.sessions.map((s, si) =>
              si === i
                ? {
                    ...s,
                    tracks: s.tracks.map((t, ti) =>
                      ti === j ? { ...t, ...patch } : t,
                    ),
                  }
                : s,
            ),
          };
          onChangeRef.current(next);
          return;
        }
      }
      const idx = v.ignored.findIndex((t) => t.key === key);
      if (idx >= 0) {
        const next: TableValue = {
          ...v,
          ignored: v.ignored.map((t, k) =>
            k === idx ? { ...t, ...patch } : t,
          ),
        };
        onChangeRef.current(next);
      }
    },
    [],
  );

  /** Patch one session by index — only that session gets a fresh identity. */
  const onSessionChange = useCallback(
    (sessionIdx: number, patch: Partial<TableSession>) => {
      const v = valueRef.current;
      if (!v.sessions[sessionIdx]) return;
      const next: TableValue = {
        ...v,
        sessions: v.sessions.map((s, i) =>
          i === sessionIdx ? { ...s, ...patch } : s,
        ),
      };
      onChangeRef.current(next);
    },
    [],
  );

  const onMoveTrack = useCallback(
    (key: string, toSessionIdx: number) => {
      const v = valueRef.current;
      let fromIdx = -1;
      let trackIdx = -1;
      for (let i = 0; i < v.sessions.length; i++) {
        const j = v.sessions[i]!.tracks.findIndex((t) => t.key === key);
        if (j >= 0) {
          fromIdx = i;
          trackIdx = j;
          break;
        }
      }
      if (fromIdx === -1 || fromIdx === toSessionIdx) return;
      if (!v.sessions[toSessionIdx]) return;
      const track = v.sessions[fromIdx]!.tracks[trackIdx]!;
      const next: TableValue = {
        ...v,
        sessions: v.sessions.map((s, i) => {
          if (i === fromIdx) {
            return { ...s, tracks: s.tracks.filter((_, j) => j !== trackIdx) };
          }
          if (i === toSessionIdx) {
            return { ...s, tracks: [...s.tracks, track] };
          }
          return s;
        }),
      };
      onChangeRef.current(next);
    },
    [],
  );

  const onIgnoreTrack = useCallback((key: string) => {
    const v = valueRef.current;
    let fromIdx = -1;
    let trackIdx = -1;
    for (let i = 0; i < v.sessions.length; i++) {
      const j = v.sessions[i]!.tracks.findIndex((t) => t.key === key);
      if (j >= 0) {
        fromIdx = i;
        trackIdx = j;
        break;
      }
    }
    if (fromIdx === -1) return;
    const track = v.sessions[fromIdx]!.tracks[trackIdx]!;
    const next: TableValue = {
      ...v,
      sessions: v.sessions.map((s, i) =>
        i === fromIdx
          ? { ...s, tracks: s.tracks.filter((_, j) => j !== trackIdx) }
          : s,
      ),
      ignored: [...v.ignored, track],
    };
    onChangeRef.current(next);
  }, []);

  const onRestoreTrack = useCallback(
    (key: string, toSessionIdx: number) => {
      const v = valueRef.current;
      const idx = v.ignored.findIndex((t) => t.key === key);
      if (idx < 0) return;
      if (!v.sessions[toSessionIdx]) return;
      const track = v.ignored[idx]!;
      const next: TableValue = {
        ...v,
        ignored: v.ignored.filter((_, k) => k !== idx),
        sessions: v.sessions.map((s, i) =>
          i === toSessionIdx ? { ...s, tracks: [...s.tracks, track] } : s,
        ),
      };
      onChangeRef.current(next);
    },
    [],
  );

  const onAddSession = useCallback(() => {
    const v = valueRef.current;
    const next: TableValue = {
      ...v,
      sessions: [
        ...v.sessions,
        {
          titleEn: "New session",
          titlePt: "",
          titleEnReviewed: true,
          titlePtReviewed: true,
          sessionDate: null,
          timePeriod: "morning",
          tracks: [],
        },
      ],
    };
    onChangeRef.current(next);
  }, []);

  const applyBulkLanguages = useCallback(() => {
    const langs = sortLanguages(bulkLangs.filter(Boolean));
    if (langs.length === 0) return;
    const v = valueRef.current;
    const setLangs = (t: TableTrack): TableTrack => ({
      ...t,
      languages: langs,
      originalLanguage: langs[0]!,
    });
    const next: TableValue = {
      sessions: v.sessions.map((s) => ({ ...s, tracks: s.tracks.map(setLangs) })),
      ignored: v.ignored.map(setLangs),
    };
    onChangeRef.current(next);
    notify(`Set ${formatLanguages(langs)} on all tracks — review before saving`, {
      type: "info",
    });
  }, [bulkLangs, notify]);

  /**
   * Fills every empty EN/PT title in the table — session titles AND track
   * titles across every session — in ONE translate request, the create-flow
   * twin of `EventFormFields`'s `fillMissing`. Here the whole table is local
   * state, so — like `applyBulkLanguages` above — the entire new `TableValue`
   * is built in one pass from a single fresh read of `valueRef.current` and
   * applied with one `onChangeRef.current(next)` call; per-item patch calls
   * would silently drop all but the last update, since each call reads the
   * same not-yet-re-rendered `valueRef.current`.
   */
  const fillMissingTranslations = useCallback(
    async (direction: TranslateDirection) => {
      const srcField: "titleEn" | "titlePt" = direction === "en-to-pt" ? "titleEn" : "titlePt";
      const tgtField: "titleEn" | "titlePt" = direction === "en-to-pt" ? "titlePt" : "titleEn";
      const tgtReviewedField: "titleEnReviewed" | "titlePtReviewed" =
        tgtField === "titleEn" ? "titleEnReviewed" : "titlePtReviewed";

      const v = valueRef.current;
      const items: Record<string, string> = {};
      v.sessions.forEach((session, i) => {
        if (session[srcField].trim() && !session[tgtField].trim()) {
          items[`session:${i}`] = session[srcField].trim();
        }
        for (const track of session.tracks) {
          const source = track[srcField].trim();
          if (source && !track[tgtField].trim()) items[`track:${track.key}`] = source;
        }
      });
      if (Object.keys(items).length === 0) {
        notify(translate("padmakara.events.translateNothing"), { type: "info" });
        return;
      }

      setTracksBulkBusy(true);
      try {
        const out = await translateFields(direction, items);
        const v2 = valueRef.current;
        const applyTrack = (t: TableTrack): TableTrack => {
          const filled = out[`track:${t.key}`];
          if (filled == null) return t;
          return { ...t, [tgtField]: filled, [tgtReviewedField]: false };
        };
        const next: TableValue = {
          sessions: v2.sessions.map((s, i) => {
            const filled = out[`session:${i}`];
            const base =
              filled != null ? { ...s, [tgtField]: filled, [tgtReviewedField]: false } : s;
            return { ...base, tracks: base.tracks.map(applyTrack) };
          }),
          ignored: v2.ignored.map(applyTrack),
        };
        onChangeRef.current(next);
      } catch (e: any) {
        notify(`${translate("padmakara.events.translateError")}${e?.message ? `: ${e.message}` : ""}`, {
          type: "error",
        });
      } finally {
        setTracksBulkBusy(false);
      }
    },
    [notify, translate],
  );

  const sessionCount = value.sessions.length;

  // Live counts for the auto-translate bar — the same selection
  // `fillMissingTranslations` acts on, so the buttons announce exactly what a
  // click will do.
  const missingCounts = (direction: TranslateDirection) => {
    const srcField: "titleEn" | "titlePt" = direction === "en-to-pt" ? "titleEn" : "titlePt";
    const tgtField: "titleEn" | "titlePt" = direction === "en-to-pt" ? "titlePt" : "titleEn";
    let sessionTitles = 0;
    let trackTitles = 0;
    for (const s of value.sessions) {
      if (s[srcField].trim() && !s[tgtField].trim()) sessionTitles++;
      for (const t of s.tracks) {
        if (t[srcField].trim() && !t[tgtField].trim()) trackTitles++;
      }
    }
    return { sessionTitles, trackTitles, total: sessionTitles + trackTitles };
  };
  const missingPt = missingCounts("en-to-pt");
  const missingEn = missingCounts("pt-to-en");
  const breakdownLabel = (m: ReturnType<typeof missingCounts>) =>
    [
      m.sessionTitles > 0
        ? translate("padmakara.events.countSessionTitles", { smart_count: m.sessionTitles })
        : null,
      m.trackTitles > 0
        ? translate("padmakara.events.countTrackTitles", { smart_count: m.trackTitles })
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const missingSummary =
    [
      missingPt.total > 0
        ? `${translate("padmakara.events.missingInPt")}: ${breakdownLabel(missingPt)}`
        : null,
      missingEn.total > 0
        ? `${translate("padmakara.events.missingInEn")}: ${breakdownLabel(missingEn)}`
        : null,
    ]
      .filter(Boolean)
      .join(" — ") || translate("padmakara.events.autoTranslateDone");

  return (
    <>
    <Paper sx={{ mb: 3 }}>
      {/* Bulk language bar — set the language(s) on every track at once, for
          the common case where a whole event is in the same language(s). */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          px: 2,
          py: 1.25,
          borderBottom: "1px solid rgba(0,0,0,0.08)",
          flexWrap: "wrap",
        }}
      >
        <Typography variant="caption" sx={{ fontWeight: 600, color: "text.secondary" }}>
          Set language for all tracks
        </Typography>
        <Select
          multiple
          size="small"
          variant="standard"
          displayEmpty
          value={bulkLangs}
          onChange={(e) => {
            const val = e.target.value;
            setBulkLangs(typeof val === "string" ? val.split(",") : val);
          }}
          renderValue={(selected) =>
            (selected as string[]).length
              ? formatLanguages(selected as string[])
              : "Choose…"
          }
          sx={{ minWidth: 120 }}
        >
          {LANGUAGE_OPTIONS.map((o) => (
            <MenuItem key={o.value} value={o.value}>
              <Checkbox checked={bulkLangs.includes(o.value)} size="small" sx={{ py: 0 }} />
              {o.label}
            </MenuItem>
          ))}
        </Select>
        <Button
          size="small"
          variant="outlined"
          onClick={applyBulkLanguages}
          disabled={bulkLangs.length === 0}
          sx={{ textTransform: "none" }}
        >
          Apply to all
        </Button>
      </Box>
      {/* Auto-translate bar — fills every empty EN/PT session/track title in
          one request, with a live count of what a click will do (mirrors the
          edit form's bar). */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 2,
          py: 1.25,
          borderBottom: "1px solid rgba(0,0,0,0.08)",
          flexWrap: "wrap",
        }}
      >
        <TranslateIcon sx={{ color: "primary.main", fontSize: 20 }} />
        <Box sx={{ flex: 1, minWidth: 220 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {translate("padmakara.events.autoTranslateTitle")}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {missingSummary}
          </Typography>
        </Box>
        <Button
          size="small"
          variant={missingPt.total > 0 ? "contained" : "outlined"}
          disableElevation
          disabled={tracksBulkBusy || missingPt.total === 0}
          startIcon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
          onClick={() => void fillMissingTranslations("en-to-pt")}
        >
          {missingPt.total > 0
            ? `${translate("padmakara.events.fillPt")} (${missingPt.total})`
            : translate("padmakara.events.ptComplete")}
        </Button>
        <Button
          size="small"
          variant={missingEn.total > 0 ? "contained" : "outlined"}
          disableElevation
          disabled={tracksBulkBusy || missingEn.total === 0}
          startIcon={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}
          onClick={() => void fillMissingTranslations("pt-to-en")}
        >
          {missingEn.total > 0
            ? `${translate("padmakara.events.fillEn")} (${missingEn.total})`
            : translate("padmakara.events.enComplete")}
        </Button>
      </Box>

      {/* One card per session — same visual language as the edit view. */}
      <Box sx={{ p: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
        {value.sessions.map((session, sIdx) => (
          <Paper
            key={sIdx}
            variant="outlined"
            sx={{ borderRadius: 2.5, overflow: "hidden", border: "1px solid rgba(0,0,0,0.08)" }}
          >
            {/* Session header: pill + click-to-edit title + date/period */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                px: 2,
                py: 1.25,
                backgroundColor: "rgba(0,0,0,0.015)",
                borderBottom: "1px solid rgba(0,0,0,0.06)",
              }}
            >
              <Box
                sx={{
                  height: 28,
                  px: 1.5,
                  borderRadius: 14,
                  backgroundColor: "primary.main",
                  color: "white",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.7rem",
                  fontWeight: 700,
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                }}
              >
                Session {sIdx + 1}
              </Box>
              <SessionTitleBlock
                session={session}
                sIdx={sIdx}
                onSessionChange={onSessionChange}
              />
              <TextField
                size="small"
                type="date"
                label="Date"
                value={session.sessionDate ?? ""}
                onChange={(e) =>
                  onSessionChange(sIdx, {
                    sessionDate: e.target.value || null,
                  })
                }
                sx={{ width: 165, flexShrink: 0 }}
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <Select
                size="small"
                value={session.timePeriod ?? "morning"}
                onChange={(e) =>
                  onSessionChange(sIdx, {
                    timePeriod: String(e.target.value),
                  })
                }
                sx={{ width: 130, flexShrink: 0 }}
              >
                {TIME_PERIODS.map((p) => (
                  <MenuItem key={p} value={p}>
                    {p}
                  </MenuItem>
                ))}
              </Select>
            </Box>

            {session.tracks.length === 0 && (
              <Box sx={{ px: 2, py: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  No tracks — move tracks here, or this empty session is
                  dropped on save.
                </Typography>
              </Box>
            )}

            {session.tracks.map((track) =>
              // Guard against a null/absent key matching the null default.
              editingKey != null && editingKey === track.key ? (
                <EditingTrackRow
                  key={track.key}
                  track={track}
                  sessionIdx={sIdx}
                  sessionCount={sessionCount}
                  teachers={teachers}
                  enableIgnore={enableIgnore}
                  enablePractice={enablePractice}
                  onTrackChange={onTrackChange}
                  onMoveTrack={onMoveTrack}
                  onIgnoreTrack={onIgnoreTrack}
                  onStopEdit={stopEdit}
                  onNavigate={(delta) => navigateEdit(track.key, delta)}
                  editableFilename={editableFilename}
                  corrections={trackCorrections?.get(track.key)}
                  bulkBusy={tracksBulkBusy}
                />
              ) : (
                <ReadonlyTrackRow
                  key={track.key}
                  track={track}
                  teachers={teachers}
                  enablePractice={enablePractice}
                  corrections={trackCorrections?.get(track.key)}
                  onEdit={startEdit}
                />
              ),
            )}
          </Paper>
        ))}
      </Box>

      <Box sx={{ px: 2, py: 1.5 }}>
        <Button onClick={onAddSession} variant="outlined" size="small">
          + Add session
        </Button>
      </Box>

      {/* Restorable ignored section */}
      {enableIgnore && value.ignored.length > 0 && (
        <Box sx={{ px: 2, pb: 2 }}>
          <Button
            size="small"
            color="inherit"
            onClick={() => setIgnoredOpen((o) => !o)}
          >
            {ignoredOpen ? "▾" : "▸"} Ignored files ({value.ignored.length})
          </Button>
          <Collapse in={ignoredOpen}>
            <Paper variant="outlined" sx={{ p: 2, mt: 1 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mb: 1 }}
              >
                These tracks are excluded from the import. Restore one to put
                it back into a session.
              </Typography>
              {value.ignored.map((track) => (
                <Box
                  key={track.key}
                  sx={{
                    display: "flex",
                    gap: 1,
                    alignItems: "center",
                    mb: 1,
                    pl: 1,
                    borderLeft: "2px solid",
                    borderColor: "divider",
                  }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2">
                      {track.titleEn || track.titlePt || track.title || track.uploadFilename}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      file: {track.uploadFilename}
                    </Typography>
                  </Box>
                  {sessionCount > 0 ? (
                    <Select
                      size="small"
                      displayEmpty
                      value=""
                      onChange={(e) =>
                        onRestoreTrack(track.key, Number(e.target.value))
                      }
                      inputProps={{
                        "aria-label": "Restore track to session",
                      }}
                      sx={{ width: 190 }}
                    >
                      <MenuItem value="" disabled>
                        Restore to…
                      </MenuItem>
                      {Array.from({ length: sessionCount }, (_, i) => (
                        <MenuItem key={i} value={i}>
                          Restore to session {i + 1}
                        </MenuItem>
                      ))}
                    </Select>
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      Add a session to restore
                    </Typography>
                  )}
                </Box>
              ))}
            </Paper>
          </Collapse>
        </Box>
      )}

    </Paper>
    </>
  );
}
