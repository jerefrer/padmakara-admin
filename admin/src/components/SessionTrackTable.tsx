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
import CircularProgress from "@mui/material/CircularProgress";
import Autocomplete from "@mui/material/Autocomplete";
import Tooltip from "@mui/material/Tooltip";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useNotify } from "react-admin";
import { authFetch } from "../utils/authFetch";
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

/** Track rows mounted per animation frame (progressive rendering). */
const PROGRESSIVE_BATCH = 20;

// --- Module-level Autocomplete helpers (stable identity across renders) -----

const getTeacherLabel = (option: Teacher | string): string =>
  typeof option === "string" ? option : option.abbreviation;

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

// --- Memoised per-track row -------------------------------------------------

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
  editableFilename,
  corrections,
}: TrackRowProps) {
  return (
    <TableRow sx={{ opacity: track.isTranslation ? 0.7 : 1 }}>
      {/* # (editable) */}
      <TableCell sx={{ pl: 2, py: 0.5 }}>
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

      {/* Filename — editable pre-upload (EventCreate), read-only otherwise */}
      <TableCell sx={{ py: 0.5, maxWidth: 240 }}>
        {editableFilename ? (
          <TextField
            size="small"
            variant="standard"
            fullWidth
            value={track.uploadFilename}
            title={track.uploadFilename}
            onChange={(e) =>
              onTrackChange(track.key, { uploadFilename: e.target.value })
            }
            InputProps={{
              sx: { fontFamily: "monospace", fontSize: "0.68rem", color: "text.secondary" },
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
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {track.uploadFilename}
          </Typography>
        )}
      </TableCell>

      {/* Title */}
      <TableCell sx={{ py: 0.5 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <TextField
            size="small"
            variant="standard"
            fullWidth
            value={track.title}
            onChange={(e) =>
              onTrackChange(track.key, { title: e.target.value })
            }
          />
          {corrections && corrections.length > 0 && (
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
          )}
        </Box>
      </TableCell>

      {/* Speaker — searchable by abbreviation OR full name; input shows abbreviation. */}
      <TableCell sx={{ py: 0.5, width: 150 }}>
        <Autocomplete
          freeSolo
          size="small"
          options={teachers}
          value={track.speaker ?? ""}
          getOptionLabel={getTeacherLabel}
          isOptionEqualToValue={isTeacherEqualToValue}
          filterOptions={filterTeacherOptions}
          renderOption={renderTeacherOption}
          onChange={(_, v) => {
            const abbr =
              v == null
                ? null
                : typeof v === "string"
                  ? v || null
                  : v.abbreviation;
            onTrackChange(track.key, { speaker: abbr });
          }}
          onInputChange={(_, v) =>
            onTrackChange(track.key, { speaker: v || null })
          }
          renderInput={(params) => (
            <TextField {...params} variant="standard" />
          )}
        />
      </TableCell>

      {/* Lang */}
      <TableCell sx={{ py: 0.5, width: 80 }}>
        <Select
          size="small"
          variant="standard"
          value={track.languages[0] ?? "en"}
          onChange={(e) =>
            onTrackChange(track.key, {
              languages: [String(e.target.value)],
            })
          }
          sx={{ width: "100%" }}
        >
          {LANGUAGE_OPTIONS.map((o) => (
            <MenuItem key={o.value} value={o.value}>
              {o.label}
            </MenuItem>
          ))}
        </Select>
      </TableCell>

      {/* Translation */}
      <TableCell sx={{ py: 0.5, width: 60 }}>
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
        <TableCell sx={{ py: 0.5, width: 60 }}>
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
        </Box>
      </TableCell>
    </TableRow>
  );
});

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

  // Progressive rendering: each track row mounts a MUI Autocomplete + several
  // inputs, so mounting 50+ rows in one render blocks the main thread (the
  // browser shows "page unresponsive" on weaker machines). Instead we render
  // rows in batches, growing the budget one animation frame at a time, so each
  // task stays short and the page stays interactive.
  const totalTracks = value.sessions.reduce((n, s) => n + s.tracks.length, 0);
  const [renderBudget, setRenderBudget] = useState(PROGRESSIVE_BATCH);
  useEffect(() => {
    if (renderBudget >= totalTracks) return;
    const id = requestAnimationFrame(() =>
      setRenderBudget((b) => b + PROGRESSIVE_BATCH),
    );
    return () => cancelAnimationFrame(id);
  }, [renderBudget, totalTracks]);

  // Prefix sum of track counts so each session knows how many of its tracks
  // fall within the current render budget.
  const trackOffsets: number[] = [];
  {
    let acc = 0;
    for (const s of value.sessions) {
      trackOffsets.push(acc);
      acc += s.tracks.length;
    }
  }
  const stillRendering = renderBudget < totalTracks;

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
          sessionDate: null,
          timePeriod: "morning",
          tracks: [],
        },
      ],
    };
    onChangeRef.current(next);
  }, []);

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

  const colCount = enablePractice ? 8 : 7;
  const sessionCount = value.sessions.length;

  return (
    <>
      {/* AI title-cleanup card — sits above the table so the reviewer can
          shape the titles in bulk before scanning the rows below. */}
      {enableAiRename && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Box sx={{ display: "flex", gap: 2, alignItems: "center" }}>
            <TextField
              fullWidth
              size="small"
              multiline
              minRows={2}
              maxRows={4}
              label="AI instruction (optional)"
              placeholder='e.g. "fix capitalisation and typos in the titles"'
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <Button
              variant="outlined"
              size="small"
              onClick={() => void handleApplyAi()}
              disabled={applyingAi || aiInstruction.trim() === ""}
              sx={{ flexShrink: 0, minWidth: 96 }}
            >
              {applyingAi ? "Applying…" : "Apply AI"}
            </Button>
          </Box>
        </Paper>
      )}
    <Paper sx={{ mb: 3 }}>
      <Box sx={{ overflowX: "auto" }}>
        <Table size="small">
          <TableHead>
            <TableRow sx={{ backgroundColor: "rgba(0,0,0,0.02)" }}>
              <TableCell sx={{ ...HEADER_CELL, width: 60, pl: 2 }}>#</TableCell>
              <TableCell sx={{ ...HEADER_CELL, maxWidth: 240 }}>
                Filename
              </TableCell>
              <TableCell sx={HEADER_CELL}>Title</TableCell>
              <TableCell sx={{ ...HEADER_CELL, width: 150 }}>Speaker</TableCell>
              <TableCell sx={{ ...HEADER_CELL, width: 80 }}>Lang</TableCell>
              <TableCell sx={{ ...HEADER_CELL, width: 60 }}>
                <Tooltip title="Translation">
                  <span>Trans</span>
                </Tooltip>
              </TableCell>
              {enablePractice && (
                <TableCell sx={{ ...HEADER_CELL, width: 60 }}>
                  <Tooltip title="Practice">
                    <span>Prac</span>
                  </Tooltip>
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
                      sx={{ display: "flex", gap: 1, alignItems: "center" }}
                    >
                      <Chip
                        label={`Session ${sIdx + 1}`}
                        size="small"
                        color="primary"
                        variant="outlined"
                      />
                      <TextField
                        size="small"
                        label="Session title"
                        value={session.titleEn}
                        onChange={(e) =>
                          onSessionChange(sIdx, { titleEn: e.target.value })
                        }
                        sx={{ flex: 1 }}
                        slotProps={{ inputLabel: { shrink: true } }}
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
                        sx={{ width: 165 }}
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
                        sx={{ width: 135 }}
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

                {session.tracks.map((track, tIdx) =>
                  trackOffsets[sIdx]! + tIdx < renderBudget ? (
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
                      editableFilename={editableFilename}
                      corrections={trackCorrections?.get(track.key)}
                    />
                  ) : null,
                )}
              </Fragment>
            ))}
            {stillRendering && (
              <TableRow>
                <TableCell colSpan={colCount} sx={{ py: 1.5, textAlign: "center" }}>
                  <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
                    <CircularProgress size={16} />
                    <Typography variant="caption" color="text.secondary">
                      Loading {totalTracks - renderBudget} more row
                      {totalTracks - renderBudget === 1 ? "" : "s"}…
                    </Typography>
                  </Box>
                </TableCell>
              </TableRow>
            )}
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
