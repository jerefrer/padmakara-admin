/**
 * RenamePreviewTable — editable table for reviewing parsed track names before upload.
 *
 * 6.3: Shows one row per ParsedTrack. The colleague can edit title, speaker,
 *      languages, and isPractice before committing. Nothing is uploaded until
 *      the parent calls handleSave.
 *
 * 6.4: An AI textarea is wired to POST /api/admin/events/:id/rename-tracks
 *      (or /api/admin/upload/rename-tracks for new events without an id yet).
 *      The AI never writes to S3/DB; it only returns suggested edits that
 *      are applied into the editable table for review.
 */

import { Fragment, useCallback, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import EditNoteIcon from "@mui/icons-material/EditNote";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { useNotify, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";
import { type InferredSession, type ParsedTrack, languageLabel } from "../utils/trackParser";

// ---------------------------------------------------------------------------
// Row edit state (flat, keyed by a per-track index within its session)
// ---------------------------------------------------------------------------

/** One editable row — mirrors ParsedTrack but only the mutable fields. */
export interface TrackEditRow {
  /** Stable identity derived from (sessionIdx, trackIdx). */
  rowKey: string;
  /** Index into the sessions array. */
  sessionIdx: number;
  /** Index of the track within the session. */
  trackIdx: number;
  /** Original (parser-produced) values, kept for display. */
  originalFilename: string;
  originalTitle: string;
  /** Currently edited values. */
  title: string;
  speaker: string;
  languages: string[];
  isPractice: boolean;
  isTranslation: boolean;
}

function buildRows(sessions: InferredSession[]): TrackEditRow[] {
  const rows: TrackEditRow[] = [];
  for (let si = 0; si < sessions.length; si++) {
    const session = sessions[si]!;
    for (let ti = 0; ti < session.tracks.length; ti++) {
      const track = session.tracks[ti]!;
      rows.push({
        rowKey: `${si}-${ti}`,
        sessionIdx: si,
        trackIdx: ti,
        originalFilename: track.originalFilename,
        originalTitle: track.title,
        title: track.title,
        speaker: track.speaker ?? "",
        languages: track.languages.length > 0 ? track.languages : [track.originalLanguage],
        isPractice: track.isPractice ?? false,
        isTranslation: track.isTranslation,
      });
    }
  }
  return rows;
}

/** Apply the edited rows back into an InferredSession[] clone. */
export function applyEditsToSessions(
  sessions: InferredSession[],
  rows: TrackEditRow[],
): InferredSession[] {
  const rowMap = new Map<string, TrackEditRow>(rows.map((r) => [r.rowKey, r]));
  return sessions.map((session, si) => ({
    ...session,
    tracks: session.tracks.map((track, ti) => {
      const row = rowMap.get(`${si}-${ti}`);
      if (!row) return track;
      return {
        ...track,
        title: row.title,
        speaker: row.speaker || null,
        languages: row.languages,
        originalLanguage: row.languages[0] ?? track.originalLanguage,
        isPractice: row.isPractice,
      } satisfies ParsedTrack;
    }),
  }));
}

// ---------------------------------------------------------------------------
// AI rename response shape
// ---------------------------------------------------------------------------

interface AiSuggestion {
  rowKey: string;
  title?: string;
  speaker?: string;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface RenamePreviewTableProps {
  sessions: InferredSession[];
  /** Called with the updated sessions whenever the user edits a row. */
  onSessionsChange: (updated: InferredSession[]) => void;
  /**
   * Optional: existing event ID used to call the backend AI route.
   * When absent (new-event flow), the AI route is called without an event id.
   */
  eventId?: number;
}

export const RenamePreviewTable = ({
  sessions,
  onSessionsChange,
  eventId,
}: RenamePreviewTableProps) => {
  const translate = useTranslate();
  const notify = useNotify();

  const [rows, setRows] = useState<TrackEditRow[]>(() => buildRows(sessions));
  const [expanded, setExpanded] = useState(true);
  const [aiInstruction, setAiInstruction] = useState("");
  const [applyingAi, setApplyingAi] = useState(false);

  // Re-initialise rows when sessions change from outside (e.g. a new folder is dropped).
  // This is intentionally a reset; edits are lost.
  const [prevSessions, setPrevSessions] = useState<InferredSession[]>(sessions);
  if (sessions !== prevSessions) {
    setPrevSessions(sessions);
    setRows(buildRows(sessions));
  }

  // Propagate row edits up to the parent
  const propagate = useCallback(
    (updated: TrackEditRow[]) => {
      onSessionsChange(applyEditsToSessions(sessions, updated));
    },
    [sessions, onSessionsChange],
  );

  const updateRow = useCallback(
    (rowKey: string, patch: Partial<TrackEditRow>) => {
      setRows((prev) => {
        const next = prev.map((r) =>
          r.rowKey === rowKey ? { ...r, ...patch } : r,
        );
        propagate(next);
        return next;
      });
    },
    [propagate],
  );

  // ---------------------------------------------------------------------------
  // AI apply (6.4)
  // ---------------------------------------------------------------------------

  const handleApplyAi = useCallback(async () => {
    if (!aiInstruction.trim()) return;
    setApplyingAi(true);
    try {
      const payload = {
        instruction: aiInstruction.trim(),
        rows: rows.map((r) => ({
          rowKey: r.rowKey,
          originalFilename: r.originalFilename,
          title: r.title,
          speaker: r.speaker,
        })),
      };

      const url = eventId
        ? `/api/admin/events/${eventId}/rename-tracks`
        : `/api/admin/upload/rename-tracks`;

      const res = await authFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status}: ${text}`);
      }

      const { suggestions }: { suggestions: AiSuggestion[] } = await res.json();

      setRows((prev) => {
        const suggestionMap = new Map<string, AiSuggestion>(
          suggestions.map((s) => [s.rowKey, s]),
        );
        const next = prev.map((r) => {
          const sug = suggestionMap.get(r.rowKey);
          if (!sug) return r;
          return {
            ...r,
            title: sug.title ?? r.title,
            speaker: sug.speaker ?? r.speaker,
          };
        });
        propagate(next);
        return next;
      });

      notify(
        translate("padmakara.renamePreview.aiApplied") || "AI suggestions applied — review and commit",
        { type: "info" },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      notify(
        `${translate("padmakara.renamePreview.aiFailed") || "AI suggestion failed"}: ${msg}`,
        { type: "error" },
      );
    } finally {
      setApplyingAi(false);
    }
  }, [aiInstruction, rows, eventId, propagate, notify, translate]);

  if (sessions.length === 0) return null;

  const totalTracks = rows.length;

  return (
    <Paper sx={{ mb: 3 }}>
      {/* Header row */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          px: 3,
          py: 2,
          borderBottom: expanded ? "1px solid rgba(0,0,0,0.06)" : "none",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <EditNoteIcon sx={{ color: "primary.main", fontSize: 22 }} />
        <Box sx={{ flex: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 600, fontSize: "1rem", lineHeight: 1.3 }}>
            {translate("padmakara.renamePreview.sectionTitle") || "Review & Edit Track Names"}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {translate("padmakara.renamePreview.sectionSubtitle") ||
              "Edit titles, speaker, and language before uploading"}
          </Typography>
        </Box>
        <Chip
          label={`${totalTracks} track${totalTracks !== 1 ? "s" : ""}`}
          size="small"
          variant="outlined"
          sx={{ height: 22, "& .MuiChip-label": { fontSize: "0.7rem" } }}
        />
        <IconButton size="small" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}>
          {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </IconButton>
      </Box>

      <Collapse in={expanded}>
        <Box sx={{ overflowX: "auto" }}>
          <Table size="small" sx={{ minWidth: 650 }}>
            <TableHead>
              <TableRow sx={{ backgroundColor: "rgba(0,0,0,0.02)" }}>
                <TableCell sx={{ fontWeight: 600, fontSize: "0.75rem", width: 40, pl: 3 }}>#</TableCell>
                <TableCell sx={{ fontWeight: 600, fontSize: "0.75rem", color: "text.secondary", maxWidth: 160 }}>
                  {translate("padmakara.renamePreview.original") || "Original filename"}
                </TableCell>
                <TableCell sx={{ fontWeight: 600, fontSize: "0.75rem" }}>
                  {translate("padmakara.renamePreview.title") || "Title"}
                </TableCell>
                <TableCell sx={{ fontWeight: 600, fontSize: "0.75rem", width: 110 }}>
                  {translate("padmakara.renamePreview.speaker") || "Speaker"}
                </TableCell>
                <TableCell sx={{ fontWeight: 600, fontSize: "0.75rem", width: 90 }}>
                  {translate("padmakara.renamePreview.lang") || "Lang"}
                </TableCell>
                <TableCell sx={{ fontWeight: 600, fontSize: "0.75rem", width: 80 }}>
                  {translate("padmakara.renamePreview.practice") || "Practice"}
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sessions.map((session, si) => (
                <Fragment key={`session-${si}`}>
                  {/* Session divider */}
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      sx={{
                        backgroundColor: "rgba(91,94,166,0.05)",
                        px: 3,
                        py: 0.75,
                        fontWeight: 600,
                        fontSize: "0.75rem",
                        color: "primary.main",
                        borderBottom: "1px solid rgba(91,94,166,0.1)",
                      }}
                    >
                      Session {session.sessionNumber}
                      {session.date ? ` — ${session.date}` : ""}
                      {session.timePeriod ? ` ${session.timePeriod}` : ""}
                    </TableCell>
                  </TableRow>
                  {/* Track rows for this session */}
                  {rows
                    .filter((r) => r.sessionIdx === si)
                    .map((row) => (
                      <TrackEditRowComponent
                        key={row.rowKey}
                        row={row}
                        onUpdate={(patch) => updateRow(row.rowKey, patch)}
                      />
                    ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Box>

        {/* AI textarea (6.4) */}
        <Box
          sx={{
            px: 3,
            py: 2,
            borderTop: "1px solid rgba(0,0,0,0.06)",
            display: "flex",
            gap: 1.5,
            alignItems: "flex-start",
          }}
        >
          <AutoFixHighIcon sx={{ color: "text.secondary", mt: 1, flexShrink: 0, fontSize: 20 }} />
          <Box sx={{ flex: 1 }}>
            <TextField
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
              placeholder={
                translate("padmakara.renamePreview.aiInstructionPlaceholder") ||
                'e.g. "number these sequentially", "strip the date prefix from titles"'
              }
              label={translate("padmakara.renamePreview.aiInstruction") || "AI instruction (optional)"}
              fullWidth
              size="small"
              multiline
              minRows={1}
              maxRows={3}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Box>
          <Button
            variant="outlined"
            size="small"
            startIcon={<AutoFixHighIcon />}
            onClick={handleApplyAi}
            disabled={applyingAi || !aiInstruction.trim()}
            sx={{ mt: 0.5, flexShrink: 0 }}
          >
            {applyingAi
              ? translate("padmakara.renamePreview.applyingAi") || "Applying…"
              : translate("padmakara.renamePreview.applyAi") || "Apply AI"}
          </Button>
        </Box>
      </Collapse>
    </Paper>
  );
};

// ---------------------------------------------------------------------------
// Individual track edit row
// ---------------------------------------------------------------------------

const LANGUAGE_OPTIONS = [
  { value: "en", label: "EN" },
  { value: "pt", label: "PT" },
  { value: "tib", label: "TIB" },
  { value: "fr", label: "FR" },
];

interface TrackEditRowComponentProps {
  row: TrackEditRow;
  onUpdate: (patch: Partial<TrackEditRow>) => void;
}

const TrackEditRowComponent = ({ row, onUpdate }: TrackEditRowComponentProps) => {
  return (
    <TableRow
      sx={{
        "&:hover": { backgroundColor: "rgba(0,0,0,0.01)" },
        opacity: row.isTranslation ? 0.75 : 1,
      }}
    >
      {/* Track number / translation badge */}
      <TableCell sx={{ pl: 3, py: 0.75 }}>
        {row.isTranslation ? (
          <Chip
            label="TR"
            size="small"
            sx={{
              height: 18,
              backgroundColor: "rgba(212,168,83,0.15)",
              color: "warning.dark",
              "& .MuiChip-label": { fontSize: "0.6rem", px: 0.5, fontWeight: 700 },
            }}
          />
        ) : (
          <Typography variant="caption" sx={{ fontFamily: "monospace", color: "text.secondary" }}>
            {/* row.rowKey shows sessionIdx-trackIdx */}
            {row.rowKey.split("-")[1] !== undefined
              ? String(Number(row.rowKey.split("-")[1]) + 1).padStart(2, "0")
              : "—"}
          </Typography>
        )}
      </TableCell>

      {/* Original filename */}
      <TableCell sx={{ py: 0.75, maxWidth: 160 }}>
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            fontSize: "0.65rem",
            color: "text.secondary",
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={row.originalFilename}
        >
          {row.originalFilename}
        </Typography>
      </TableCell>

      {/* Title (editable) */}
      <TableCell sx={{ py: 0.5 }}>
        <TextField
          value={row.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          size="small"
          fullWidth
          variant="standard"
          slotProps={{
            input: { sx: { fontSize: "0.82rem" } },
          }}
        />
      </TableCell>

      {/* Speaker (editable) */}
      <TableCell sx={{ py: 0.5, width: 110 }}>
        <TextField
          value={row.speaker}
          onChange={(e) => onUpdate({ speaker: e.target.value })}
          size="small"
          fullWidth
          variant="standard"
          placeholder="—"
          slotProps={{
            input: { sx: { fontSize: "0.82rem", fontFamily: "monospace" } },
          }}
        />
      </TableCell>

      {/* Language (single select for primary lang) */}
      <TableCell sx={{ py: 0.5, width: 90 }}>
        <Select
          value={row.languages[0] ?? "en"}
          onChange={(e) => {
            const lang = e.target.value as string;
            onUpdate({ languages: [lang], isTranslation: lang === "pt" && row.isTranslation });
          }}
          size="small"
          variant="standard"
          sx={{ fontSize: "0.82rem", width: "100%" }}
        >
          {LANGUAGE_OPTIONS.map((opt) => (
            <MenuItem key={opt.value} value={opt.value} sx={{ fontSize: "0.82rem" }}>
              {opt.label}
            </MenuItem>
          ))}
        </Select>
      </TableCell>

      {/* Practice flag */}
      <TableCell sx={{ py: 0.5, width: 80 }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={row.isPractice}
              onChange={(e) => onUpdate({ isPractice: e.target.checked })}
              size="small"
              sx={{ p: 0.5 }}
            />
          }
          label=""
          sx={{ m: 0 }}
        />
      </TableCell>
    </TableRow>
  );
};
