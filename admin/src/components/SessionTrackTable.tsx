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
 *   - `TrackRow` is `memo()`-wrapped, so a track whose props are reference-
 *     equal to the previous render is skipped entirely.
 *   - This only pays off when the parent feeds the table identity-stable
 *     props — see the adapters on each screen, which cache per source track.
 */

import {
  Fragment,
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
import MenuItem from "@mui/material/MenuItem";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Checkbox from "@mui/material/Checkbox";
import Collapse from "@mui/material/Collapse";
import Autocomplete from "@mui/material/Autocomplete";
import Tooltip from "@mui/material/Tooltip";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import CircularProgress from "@mui/material/CircularProgress";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import CheckIcon from "@mui/icons-material/Check";
import { useNotify, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";
import { translateFields, type TranslateDirection } from "../utils/translateFields";
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
  /** Show the AI title-cleanup box (POSTs /api/admin/upload/rename-tracks). */
  enableAiRename?: boolean;
  /** Allow editing each track's filename (the future S3 key). Only safe
   *  pre-upload (EventCreate); the migration flow's files already live on S3,
   *  so it leaves this off and shows the filename read-only. */
  editableFilename?: boolean;
  /** When provided, tracks whose `key` matches get an AI-correction badge
   *  with a tooltip listing the diffs. */
  trackCorrections?: TrackCorrectionsMap;
}

interface AiSuggestion {
  rowKey: string;
  title?: string;
  speaker?: string;
}

const HEADER_CELL = {
  fontWeight: 600,
  fontSize: "0.72rem",
  color: "text.secondary",
} as const;


// --- Module-level Autocomplete helpers (stable identity across renders) -----

// The speaker is stored as an abbreviation but shown as the full name.
const getTeacherLabel = (option: Teacher | string): string =>
  typeof option === "string" ? option : option.name;

/** Resolve a stored speaker abbreviation to the teacher's full name for display. */
const teacherDisplayName = (teachers: Teacher[], abbr: string | null): string => {
  if (!abbr) return "";
  return teachers.find((t) => t.abbreviation === abbr)?.name ?? abbr;
};

const isTeacherEqualToValue = (
  option: Teacher,
  val: Teacher | string,
): boolean =>
  typeof val === "string" ? option.abbreviation === val : option.id === val.id;

const filterTeacherOptions = (
  opts: Teacher[],
  state: { inputValue: string },
): Teacher[] => {
  const q = state.inputValue.trim().toLowerCase();
  if (!q) return opts;
  return opts.filter(
    (o) =>
      o.abbreviation.toLowerCase().includes(q) ||
      o.name.toLowerCase().includes(q),
  );
};

const renderTeacherOption = (
  props: React.HTMLAttributes<HTMLLIElement> & { key?: React.Key },
  option: Teacher,
) => (
  <li {...props} key={option.id}>
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        lineHeight: 1.15,
        py: 0.25,
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        {option.abbreviation}
      </Typography>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {option.name}
      </Typography>
    </Box>
  </li>
);

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
  const cell = { py: 0.75 } as const;
  const mark = (on: boolean) =>
    on ? <CheckIcon fontSize="small" sx={{ color: "success.main" }} /> : null;
  return (
    <TableRow
      hover
      sx={{ opacity: track.isTranslation ? 0.7 : 1, cursor: "pointer" }}
      onClick={() => onEdit(track.key)}
    >
      <TableCell sx={{ ...cell, pl: 2, width: 50 }}>{track.trackNumber}</TableCell>
      {/* Title (top) + filename (below), stacked so the filename has full width */}
      <TableCell sx={cell}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2">{track.title}</Typography>
            <Typography
              variant="caption"
              sx={{
                fontFamily: "monospace",
                fontSize: "0.65rem",
                color: "text.secondary",
                display: "block",
                wordBreak: "break-all",
              }}
            >
              {track.uploadFilename}
            </Typography>
          </Box>
          <CorrectionsBadge corrections={corrections ?? []} />
        </Box>
      </TableCell>
      <TableCell sx={{ ...cell, width: 150, textAlign: "center" }}>
        {track.speaker ? (
          <Typography variant="body2" color="text.secondary">
            {teacherDisplayName(teachers, track.speaker)}
          </Typography>
        ) : null}
      </TableCell>
      <TableCell sx={{ ...cell, width: 90, textAlign: "center" }}>
        <Typography variant="caption" color="text.secondary">
          {formatLanguages(track.languages)}
        </Typography>
      </TableCell>
      <TableCell sx={{ ...cell, width: 100, textAlign: "center" }}>
        {mark(track.isTranslation)}
      </TableCell>
      {enablePractice && (
        <TableCell sx={{ ...cell, width: 90, textAlign: "center" }}>
          {mark(track.isPractice)}
        </TableCell>
      )}
      <TableCell sx={{ ...cell }}>
        <Button
          size="small"
          startIcon={<EditOutlinedIcon />}
          onClick={(e) => {
            e.stopPropagation();
            onEdit(track.key);
          }}
          sx={{ textTransform: "none" }}
        >
          Edit
        </Button>
      </TableCell>
    </TableRow>
  );
});

// --- Memoised per-track row (editable) --------------------------------------

interface TrackRowProps {
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
  editableFilename: boolean;
  /** AI corrections to flag on this row (rendered as a Tooltip-equipped chip). */
  corrections?: TrackCorrection[];
}

const TrackRow = memo(function TrackRow({
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
  editableFilename,
  corrections,
}: TrackRowProps) {
  return (
    <TableRow sx={{ opacity: track.isTranslation ? 0.7 : 1 }}>
      {/* # (editable) */}
      <TableCell sx={{ pl: 2, py: 0.5, width: 50 }}>
        <TextField
          type="number"
          size="small"
          variant="standard"
          value={track.trackNumber}
          onChange={(e) =>
            onTrackChange(track.key, {
              trackNumber: Number.parseInt(e.target.value, 10) || 0,
            })
          }
          sx={{ width: 50 }}
        />
      </TableCell>

      {/* Title (top) + filename (below), stacked so both inputs are full width;
          the corrections badge sits to the right, centred across the two. */}
      <TableCell sx={{ py: 0.5 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
            <TextField
              size="small"
              variant="standard"
              fullWidth
              label="Title"
              value={track.title}
              onChange={(e) =>
                onTrackChange(track.key, { title: e.target.value })
              }
              slotProps={{ inputLabel: { shrink: true } }}
            />
            {editableFilename ? (
              <TextField
                size="small"
                variant="standard"
                fullWidth
                label="Filename"
                value={track.uploadFilename}
                title={track.uploadFilename}
                onChange={(e) =>
                  onTrackChange(track.key, { uploadFilename: e.target.value })
                }
                slotProps={{ inputLabel: { shrink: true } }}
                InputProps={{
                  sx: { fontFamily: "monospace", fontSize: "0.72rem", color: "text.secondary" },
                }}
              />
            ) : (
              <Typography
                variant="caption"
                title={track.uploadFilename}
                sx={{
                  fontFamily: "monospace",
                  fontSize: "0.65rem",
                  color: "text.secondary",
                  display: "block",
                  wordBreak: "break-all",
                }}
              >
                {track.uploadFilename}
              </Typography>
            )}
          </Box>
          <CorrectionsBadge corrections={corrections ?? []} />
        </Box>
      </TableCell>

      {/* Speaker — searchable by abbreviation OR full name. */}
      <TableCell sx={{ py: 0.5, width: 150 }}>
        <Autocomplete
          freeSolo
          size="small"
          options={teachers}
          // Show the full name; the stored value stays the abbreviation.
          value={teachers.find((t) => t.abbreviation === track.speaker) ?? track.speaker ?? ""}
          getOptionLabel={getTeacherLabel}
          isOptionEqualToValue={isTeacherEqualToValue}
          filterOptions={filterTeacherOptions}
          renderOption={renderTeacherOption}
          // Commit on selection / Enter (not on every keystroke). A free-typed
          // value is resolved to a known teacher by name or abbreviation.
          onChange={(_, v) => {
            if (v == null) {
              onTrackChange(track.key, { speaker: null });
              return;
            }
            if (typeof v === "string") {
              const q = v.trim().toLowerCase();
              const match = teachers.find(
                (t) => t.abbreviation.toLowerCase() === q || t.name.toLowerCase() === q,
              );
              onTrackChange(track.key, { speaker: match ? match.abbreviation : v || null });
              return;
            }
            onTrackChange(track.key, { speaker: v.abbreviation });
          }}
          renderInput={(params) => <TextField {...params} variant="standard" />}
        />
      </TableCell>

      {/* Lang — multi-select: a single file can carry several languages
          (e.g. TIB+ENG). originalLanguage tracks the first (source) language. */}
      <TableCell sx={{ py: 0.5, width: 110 }}>
        <Select
          multiple
          size="small"
          variant="standard"
          value={track.languages.length ? track.languages : ["en"]}
          onChange={(e) => {
            const val = e.target.value;
            const raw = typeof val === "string" ? val.split(",") : val;
            const langs = sortLanguages(raw.filter(Boolean));
            const next = langs.length ? langs : ["en"];
            onTrackChange(track.key, {
              languages: next,
              originalLanguage: next[0]!,
            });
          }}
          renderValue={(selected) => formatLanguages(selected as string[])}
          sx={{ width: "100%" }}
        >
          {LANGUAGE_OPTIONS.map((o) => (
            <MenuItem key={o.value} value={o.value}>
              <Checkbox checked={track.languages.includes(o.value)} size="small" sx={{ py: 0 }} />
              {o.label}
            </MenuItem>
          ))}
        </Select>
      </TableCell>

      {/* Translation */}
      <TableCell sx={{ py: 0.5, width: 100, textAlign: "center" }}>
        <Checkbox
          size="small"
          checked={track.isTranslation}
          onChange={(e) =>
            onTrackChange(track.key, { isTranslation: e.target.checked })
          }
          sx={{ p: 0.5 }}
        />
      </TableCell>

      {/* Practice */}
      {enablePractice && (
        <TableCell sx={{ py: 0.5, width: 90, textAlign: "center" }}>
          <Checkbox
            size="small"
            checked={track.isPractice}
            onChange={(e) =>
              onTrackChange(track.key, { isPractice: e.target.checked })
            }
            sx={{ p: 0.5 }}
          />
        </TableCell>
      )}

      {/* Actions: move-to-session + ignore */}
      <TableCell sx={{ py: 0.5, width: enableIgnore ? 250 : 170 }}>
        <Box sx={{ display: "flex", gap: 0.5, alignItems: "center" }}>
          <Select
            size="small"
            variant="standard"
            value={sessionIdx}
            onChange={(e) =>
              onMoveTrack(track.key, Number(e.target.value))
            }
            inputProps={{ "aria-label": "Move track to session" }}
            sx={{ flex: 1, fontSize: "0.78rem" }}
          >
            {Array.from({ length: sessionCount }, (_, i) => (
              <MenuItem key={i} value={i}>
                {i === sessionIdx
                  ? "— this session —"
                  : `→ Session ${i + 1}`}
              </MenuItem>
            ))}
          </Select>
          {enableIgnore && (
            <Button
              size="small"
              color="warning"
              onClick={() => onIgnoreTrack(track.key)}
            >
              Ignore
            </Button>
          )}
          <Button
            size="small"
            variant="contained"
            startIcon={<CheckIcon />}
            onClick={onStopEdit}
            sx={{ textTransform: "none" }}
          >
            Done
          </Button>
        </Box>
      </TableCell>
    </TableRow>
  );
});

// --- Session title EN/PT editor ---------------------------------------------

interface SessionTitleEditorProps {
  session: TableSession;
  sIdx: number;
  onSessionChange: (sessionIdx: number, patch: Partial<TableSession>) => void;
}

/**
 * EN/PT session-title editor with a translate-into-the-other-side button,
 * mirroring the pattern used by `SessionCard` in SessionPreview.tsx (the
 * edit-flow equivalent). Extracted into its own component — rather than a
 * single `translating` flag on the table — so each session row's in-flight
 * translate state is independent; sessions are rendered in a map and a
 * shared flag would light up every row's spinner at once.
 */
function SessionTitleEditor({ session, sIdx, onSessionChange }: SessionTitleEditorProps) {
  const translate = useTranslate();
  const notify = useNotify();
  const [translating, setTranslating] = useState<"titleEn" | "titlePt" | null>(null);

  const translateSide = async (
    source: "titleEn" | "titlePt",
    target: "titleEn" | "titlePt",
    targetReviewed: "titleEnReviewed" | "titlePtReviewed",
    direction: TranslateDirection,
  ) => {
    const text = session[source].trim();
    if (!text) return;
    setTranslating(source);
    try {
      const out = await translateFields(direction, { [target]: text });
      onSessionChange(sIdx, {
        [target]: out[target] ?? "",
        [targetReviewed]: false,
      } as Partial<TableSession>);
    } catch (e: any) {
      notify(
        `${translate("padmakara.events.translateError")}${e?.message ? `: ${e.message}` : ""}`,
        { type: "error" },
      );
    } finally {
      setTranslating(null);
    }
  };

  return (
    <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
      <TextField
        size="small"
        label={translate("padmakara.events.titleEn") || "Session title (EN)"}
        value={session.titleEn}
        onChange={(e) =>
          onSessionChange(sIdx, { titleEn: e.target.value, titleEnReviewed: true })
        }
        sx={{ width: "100%" }}
        slotProps={{ inputLabel: { shrink: true } }}
      />
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Button
          size="small"
          variant="text"
          disabled={!session.titleEn.trim() || translating !== null}
          startIcon={translating === "titleEn" ? <CircularProgress size={14} /> : undefined}
          onClick={() => translateSide("titleEn", "titlePt", "titlePtReviewed", "en-to-pt")}
        >
          {translate("padmakara.events.translateToPt")}
        </Button>
        {!session.titleEnReviewed && (
          <>
            <Chip
              size="small"
              color="warning"
              variant="outlined"
              label={translate("padmakara.events.aiUnreviewed")}
            />
            <Button
              size="small"
              variant="text"
              onClick={() => onSessionChange(sIdx, { titleEnReviewed: true })}
            >
              {translate("padmakara.events.markReviewed")}
            </Button>
          </>
        )}
      </Box>
      <TextField
        size="small"
        label={translate("padmakara.events.titlePt") || "Session title (PT)"}
        value={session.titlePt}
        onChange={(e) =>
          onSessionChange(sIdx, { titlePt: e.target.value, titlePtReviewed: true })
        }
        sx={{ width: "100%" }}
        slotProps={{ inputLabel: { shrink: true } }}
      />
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Button
          size="small"
          variant="text"
          disabled={!session.titlePt.trim() || translating !== null}
          startIcon={translating === "titlePt" ? <CircularProgress size={14} /> : undefined}
          onClick={() => translateSide("titlePt", "titleEn", "titleEnReviewed", "pt-to-en")}
        >
          {translate("padmakara.events.translateToEn")}
        </Button>
        {!session.titlePtReviewed && (
          <>
            <Chip
              size="small"
              color="warning"
              variant="outlined"
              label={translate("padmakara.events.aiUnreviewed")}
            />
            <Button
              size="small"
              variant="text"
              onClick={() => onSessionChange(sIdx, { titlePtReviewed: true })}
            >
              {translate("padmakara.events.markReviewed")}
            </Button>
          </>
        )}
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
  enableAiRename = false,
  editableFilename = false,
  trackCorrections,
}: SessionTrackTableProps) {
  const notify = useNotify();
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [applyingAi, setApplyingAi] = useState(false);
  // Bulk language assignment — most events are uniform (every track TIB+ENG,
  // or every track ENG+PT), so one control sets the languages on all tracks.
  const [bulkLangs, setBulkLangs] = useState<string[]>([]);

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

  const handleApplyAi = useCallback(async () => {
    const instruction = aiInstruction.trim();
    if (!instruction) return;
    setApplyingAi(true);
    try {
      const v = valueRef.current;
      const rows = [
        ...v.sessions.flatMap((s) => s.tracks),
        ...v.ignored,
      ].map((t) => ({
        rowKey: t.key,
        originalFilename: t.uploadFilename,
        title: t.title,
        speaker: t.speaker ?? "",
      }));
      const res = await authFetch("/api/admin/upload/rename-tracks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction, rows }),
      });
      if (!res.ok) {
        throw new Error(`${res.status}: ${await res.text()}`);
      }
      const { suggestions } = (await res.json()) as {
        suggestions: AiSuggestion[];
      };
      const byKey = new Map(suggestions.map((s) => [s.rowKey, s]));
      const v2 = valueRef.current;
      const applyTo = (t: TableTrack): TableTrack => {
        const sug = byKey.get(t.key);
        if (!sug) return t;
        return {
          ...t,
          title: sug.title ?? t.title,
          speaker: sug.speaker ?? t.speaker,
        };
      };
      const next: TableValue = {
        sessions: v2.sessions.map((s) => ({
          ...s,
          tracks: s.tracks.map(applyTo),
        })),
        ignored: v2.ignored.map(applyTo),
      };
      onChangeRef.current(next);
      notify("AI suggestions applied — review before saving", { type: "info" });
    } catch (e) {
      notify(`AI suggestion failed: ${(e as Error).message}`, {
        type: "error",
      });
    } finally {
      setApplyingAi(false);
    }
  }, [aiInstruction, notify]);

  // Columns: # | Title/Filename | Speaker | Lang | Trans | [Prac] | Actions
  const colCount = enablePractice ? 7 : 6;
  const sessionCount = value.sessions.length;

  return (
    <>
      {/* AI bulk-edit card — visually distinct from the plain form fields so
          it reads as an AI action, not just another input. */}
      {enableAiRename && (
        <Paper
          variant="outlined"
          sx={{
            p: 2,
            mb: 2,
            borderColor: "rgba(91,94,166,0.35)",
            background:
              "linear-gradient(135deg, rgba(91,94,166,0.07), rgba(91,94,166,0.02))",
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.25 }}>
            <AutoAwesomeIcon sx={{ color: "primary.main", fontSize: 20 }} />
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              AI bulk edit
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Describe a change to apply across all titles below
            </Typography>
          </Box>
          <Box sx={{ display: "flex", gap: 2, alignItems: "center" }}>
            <TextField
              fullWidth
              size="small"
              multiline
              minRows={3}
              maxRows={6}
              placeholder={
                'e.g. "Capitalise every title in Title Case" or ' +
                '"Remove the speaker initials from the titles"'
              }
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
              sx={{ backgroundColor: "background.paper", borderRadius: 1 }}
            />
            <Button
              variant="contained"
              startIcon={<AutoAwesomeIcon />}
              onClick={() => void handleApplyAi()}
              disabled={applyingAi || aiInstruction.trim() === ""}
              sx={{ flexShrink: 0, minWidth: 120, textTransform: "none", borderRadius: 2 }}
            >
              {applyingAi ? "Applying…" : "Apply"}
            </Button>
          </Box>
        </Paper>
      )}
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
      <Box sx={{ overflowX: "auto" }}>
        <Table size="small">
          <TableHead>
            <TableRow sx={{ backgroundColor: "rgba(0,0,0,0.02)" }}>
              <TableCell sx={{ ...HEADER_CELL, width: 50, pl: 2 }}>#</TableCell>
              <TableCell sx={HEADER_CELL}>Title / Filename</TableCell>
              <TableCell sx={{ ...HEADER_CELL, width: 150, textAlign: "center" }}>
                Speaker
              </TableCell>
              <TableCell sx={{ ...HEADER_CELL, width: 90, textAlign: "center" }}>
                Language
              </TableCell>
              <TableCell sx={{ ...HEADER_CELL, width: 100, textAlign: "center" }}>
                Translation
              </TableCell>
              {enablePractice && (
                <TableCell sx={{ ...HEADER_CELL, width: 90, textAlign: "center" }}>
                  Practice
                </TableCell>
              )}
              <TableCell
                sx={{ ...HEADER_CELL, width: enableIgnore ? 250 : 170 }}
              />
            </TableRow>
          </TableHead>
          <TableBody>
            {value.sessions.map((session, sIdx) => (
              <Fragment key={sIdx}>
                {/* Editable session header (inline — a few per table, not the hot path). */}
                <TableRow>
                  <TableCell
                    colSpan={colCount}
                    sx={{
                      backgroundColor: "rgba(91,94,166,0.06)",
                      borderBottom: "1px solid rgba(91,94,166,0.12)",
                      py: 1,
                    }}
                  >
                    <Box
                      sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}
                    >
                      <Chip
                        label={`Session ${sIdx + 1}`}
                        size="small"
                        color="primary"
                        variant="outlined"
                        sx={{ mt: 0.75 }}
                      />
                      <SessionTitleEditor
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
                        sx={{ width: 165, mt: 0.25 }}
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
                        sx={{ width: 135, mt: 0.25 }}
                      >
                        {TIME_PERIODS.map((p) => (
                          <MenuItem key={p} value={p}>
                            {p}
                          </MenuItem>
                        ))}
                      </Select>
                    </Box>
                  </TableCell>
                </TableRow>

                {session.tracks.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={colCount}>
                      <Typography variant="caption" color="text.secondary">
                        No tracks — move tracks here, or this empty session is
                        dropped on save.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}

                {session.tracks.map((track) =>
                  // Guard against a null/absent key matching the null default.
                  editingKey != null && editingKey === track.key ? (
                    <TrackRow
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
                      editableFilename={editableFilename}
                      corrections={trackCorrections?.get(track.key)}
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
              </Fragment>
            ))}
          </TableBody>
        </Table>
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
                      {track.title || track.uploadFilename}
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
