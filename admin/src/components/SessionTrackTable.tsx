/**
 * SessionTrackTable — one shared editable table for tracks grouped into
 * sessions, used by both import flows (folder-upload EventCreate and the
 * legacy Migration screen). It is fully controlled: it operates on a neutral
 * `TableValue`; each screen bridges its own model with thin adapters keyed by
 * a stable per-track `key`.
 */

import { Fragment, useCallback, useState } from "react";
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
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import { useNotify } from "react-admin";
import { authFetch } from "../utils/authFetch";
import type { TrackCorrection } from "../utils/analyzeFolder";

/**
 * A track as the table edits it — no File / no importFileId; those stay in
 * the screen's own model and are re-merged by `key`.
 */
export interface TableTrack {
  /** Stable identity within this table (survives edits and moves). */
  key: string;
  originalFilename: string;
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

/**
 * Map from corrected filename → corrections that were applied to that track.
 * Provided by the AI analysis flow; undefined in all other uses.
 */
export type TrackCorrectionsMap = Map<string, TrackCorrection[]>;

const TIME_PERIODS = ["morning", "afternoon"];
const LANGUAGE_OPTIONS = [
  { value: "en", label: "EN" },
  { value: "pt", label: "PT" },
  { value: "tib", label: "TIB" },
  { value: "fr", label: "FR" },
];

interface SessionTrackTableProps {
  value: TableValue;
  onChange: (next: TableValue) => void;
  /** DB teachers — populate the per-track speaker combobox. */
  teachers: { id: number; name: string; abbreviation: string }[];
  /** Show the per-track "ignore" action + the restorable ignored section. */
  enableIgnore?: boolean;
  /** Show the per-track "practice" checkbox column. */
  enablePractice?: boolean;
  /** Show the AI title-cleanup box (POSTs /api/admin/upload/rename-tracks). */
  enableAiRename?: boolean;
  /**
   * AI-analysis corrections keyed by corrected filename. When provided,
   * tracks with corrections show a small badge in the title cell.
   * When undefined the component renders identically to before (backward-compat).
   */
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

export function SessionTrackTable({
  value,
  onChange,
  teachers,
  enableIgnore = false,
  enablePractice = false,
  enableAiRename = false,
  trackCorrections,
}: SessionTrackTableProps) {
  const notify = useNotify();
  const [ignoredOpen, setIgnoredOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [applyingAi, setApplyingAi] = useState(false);

  const update = useCallback(
    (mutate: (draft: TableValue) => void) => {
      const draft = structuredClone(value);
      mutate(draft);
      onChange(draft);
    },
    [value, onChange],
  );

  const moveTrack = useCallback(
    (fromIdx: number, trackIdx: number, toIdx: number) => {
      if (fromIdx === toIdx) return;
      update((d) => {
        const from = d.sessions[fromIdx];
        const to = d.sessions[toIdx];
        if (!from || !to) return;
        const [track] = from.tracks.splice(trackIdx, 1);
        if (track) to.tracks.push(track);
      });
    },
    [update],
  );

  const ignoreTrack = useCallback(
    (sIdx: number, trackIdx: number) => {
      update((d) => {
        const session = d.sessions[sIdx];
        if (!session) return;
        const [track] = session.tracks.splice(trackIdx, 1);
        if (track) d.ignored.push(track);
      });
    },
    [update],
  );

  const restoreTrack = useCallback(
    (ignoredIdx: number, toSessionIdx: number) => {
      update((d) => {
        const target = d.sessions[toSessionIdx];
        if (!target) return;
        const [track] = d.ignored.splice(ignoredIdx, 1);
        if (track) target.tracks.push(track);
      });
    },
    [update],
  );

  const addSession = useCallback(() => {
    update((d) => {
      d.sessions.push({
        titleEn: "New session",
        sessionDate: null,
        timePeriod: "morning",
        tracks: [],
      });
    });
  }, [update]);

  const handleApplyAi = useCallback(async () => {
    const instruction = aiInstruction.trim();
    if (!instruction) return;
    setApplyingAi(true);
    try {
      const rows = [
        ...value.sessions.flatMap((s) => s.tracks),
        ...value.ignored,
      ].map((t) => ({
        rowKey: t.key,
        originalFilename: t.originalFilename,
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
      update((d) => {
        const apply = (t: TableTrack) => {
          const sug = byKey.get(t.key);
          if (!sug) return;
          if (sug.title !== undefined) t.title = sug.title;
          if (sug.speaker !== undefined) t.speaker = sug.speaker;
        };
        for (const s of d.sessions) for (const t of s.tracks) apply(t);
        for (const t of d.ignored) apply(t);
      });
      notify("AI suggestions applied — review before saving", { type: "info" });
    } catch (e) {
      notify(`AI suggestion failed: ${(e as Error).message}`, {
        type: "error",
      });
    } finally {
      setApplyingAi(false);
    }
  }, [aiInstruction, value, update, notify]);

  const colCount = enablePractice ? 7 : 6;

  return (
    <Paper sx={{ mb: 3 }}>
      <Box sx={{ overflowX: "auto" }}>
        <Table size="small">
          <TableHead>
            <TableRow sx={{ backgroundColor: "rgba(0,0,0,0.02)" }}>
              <TableCell sx={{ ...HEADER_CELL, width: 90, pl: 2 }}>#</TableCell>
              <TableCell sx={{ ...HEADER_CELL, maxWidth: 200 }}>
                Original filename
              </TableCell>
              <TableCell sx={HEADER_CELL}>Title</TableCell>
              <TableCell sx={{ ...HEADER_CELL, width: 150 }}>Speaker</TableCell>
              <TableCell sx={{ ...HEADER_CELL, width: 80 }}>Lang</TableCell>
              {enablePractice && (
                <TableCell sx={{ ...HEADER_CELL, width: 70 }}>Practice</TableCell>
              )}
              <TableCell sx={{ ...HEADER_CELL, width: enableIgnore ? 250 : 170 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {value.sessions.map((session, sIdx) => (
              <Fragment key={sIdx}>
                {/* Editable session header */}
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
                          update((d) => {
                            const s = d.sessions[sIdx];
                            if (s) s.titleEn = e.target.value;
                          })
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
                          update((d) => {
                            const s = d.sessions[sIdx];
                            if (s) s.sessionDate = e.target.value || null;
                          })
                        }
                        sx={{ width: 165 }}
                        slotProps={{ inputLabel: { shrink: true } }}
                      />
                      <Select
                        size="small"
                        value={session.timePeriod ?? "morning"}
                        onChange={(e) =>
                          update((d) => {
                            const s = d.sessions[sIdx];
                            if (s) s.timePeriod = String(e.target.value);
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

                {session.tracks.map((track, tIdx) => (
                  <TableRow
                    key={track.key}
                    sx={{ opacity: track.isTranslation ? 0.7 : 1 }}
                  >
                    {/* Track number (editable) + translation badge */}
                    <TableCell sx={{ pl: 2, py: 0.5 }}>
                      <Box
                        sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
                      >
                        <TextField
                          type="number"
                          size="small"
                          variant="standard"
                          value={track.trackNumber}
                          onChange={(e) =>
                            update((d) => {
                              const t = d.sessions[sIdx]?.tracks[tIdx];
                              if (t)
                                t.trackNumber =
                                  Number.parseInt(e.target.value, 10) || 0;
                            })
                          }
                          sx={{ width: 44 }}
                        />
                        {track.isTranslation && (
                          <Chip
                            label="TR"
                            size="small"
                            sx={{
                              height: 18,
                              "& .MuiChip-label": {
                                fontSize: "0.6rem",
                                px: 0.5,
                                fontWeight: 700,
                              },
                            }}
                          />
                        )}
                      </Box>
                    </TableCell>

                    {/* Original filename (read-only) */}
                    <TableCell sx={{ py: 0.5, maxWidth: 200 }}>
                      <Typography
                        variant="caption"
                        title={track.originalFilename}
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
                        {track.originalFilename}
                      </Typography>
                    </TableCell>

                    {/* Title (editable) */}
                    <TableCell sx={{ py: 0.5 }}>
                      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                        <TextField
                          size="small"
                          variant="standard"
                          fullWidth
                          value={track.title}
                          onChange={(e) =>
                            update((d) => {
                              const t = d.sessions[sIdx]?.tracks[tIdx];
                              if (t) t.title = e.target.value;
                            })
                          }
                        />
                        {(() => {
                          const corr = trackCorrections?.get(track.originalFilename);
                          if (!corr || corr.length === 0) return null;
                          const tipLines = corr.map(
                            (c) => `${c.field}: "${c.before}" → "${c.after}" — ${c.reason}`,
                          );
                          return (
                            <Tooltip
                              title={
                                <Box component="span" sx={{ whiteSpace: "pre-line" }}>
                                  {tipLines.join("\n")}
                                </Box>
                              }
                              arrow
                            >
                              <Chip
                                icon={<AutoFixHighIcon />}
                                label={`${corr.length}`}
                                color="warning"
                                size="small"
                                variant="outlined"
                                sx={{ flexShrink: 0, height: 22, "& .MuiChip-label": { px: 0.5, fontSize: "0.65rem" }, "& .MuiChip-icon": { fontSize: "0.8rem" } }}
                              />
                            </Tooltip>
                          );
                        })()}
                      </Box>
                    </TableCell>

                    {/* Speaker (editable combobox) */}
                    <TableCell sx={{ py: 0.5, width: 150 }}>
                      <Autocomplete
                        freeSolo
                        size="small"
                        options={teachers.map((t) => t.abbreviation)}
                        value={track.speaker ?? ""}
                        onChange={(_, v) =>
                          update((d) => {
                            const t = d.sessions[sIdx]?.tracks[tIdx];
                            if (t) t.speaker = v || null;
                          })
                        }
                        onInputChange={(_, v) =>
                          update((d) => {
                            const t = d.sessions[sIdx]?.tracks[tIdx];
                            if (t) t.speaker = v || null;
                          })
                        }
                        renderInput={(params) => (
                          <TextField {...params} variant="standard" />
                        )}
                      />
                    </TableCell>

                    {/* Language */}
                    <TableCell sx={{ py: 0.5, width: 80 }}>
                      <Select
                        size="small"
                        variant="standard"
                        value={track.languages[0] ?? "en"}
                        onChange={(e) =>
                          update((d) => {
                            const t = d.sessions[sIdx]?.tracks[tIdx];
                            if (t) t.languages = [String(e.target.value)];
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

                    {/* Practice flag */}
                    {enablePractice && (
                      <TableCell sx={{ py: 0.5, width: 70 }}>
                        <Checkbox
                          size="small"
                          checked={track.isPractice}
                          onChange={(e) =>
                            update((d) => {
                              const t = d.sessions[sIdx]?.tracks[tIdx];
                              if (t) t.isPractice = e.target.checked;
                            })
                          }
                          sx={{ p: 0.5 }}
                        />
                      </TableCell>
                    )}

                    {/* Actions: move between sessions + ignore */}
                    <TableCell
                      sx={{ py: 0.5, width: enableIgnore ? 250 : 170 }}
                    >
                      <Box
                        sx={{ display: "flex", gap: 0.5, alignItems: "center" }}
                      >
                        <Select
                          size="small"
                          variant="standard"
                          value={sIdx}
                          onChange={(e) =>
                            moveTrack(sIdx, tIdx, Number(e.target.value))
                          }
                          inputProps={{ "aria-label": "Move track to session" }}
                          sx={{ flex: 1, fontSize: "0.78rem" }}
                        >
                          {value.sessions.map((_, i) => (
                            <MenuItem key={i} value={i}>
                              {i === sIdx
                                ? "— this session —"
                                : `→ Session ${i + 1}`}
                            </MenuItem>
                          ))}
                        </Select>
                        {enableIgnore && (
                          <Button
                            size="small"
                            color="warning"
                            onClick={() => ignoreTrack(sIdx, tIdx)}
                          >
                            Ignore
                          </Button>
                        )}
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </Box>

      <Box sx={{ px: 2, py: 1.5 }}>
        <Button onClick={addSession} variant="outlined" size="small">
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
              {value.ignored.map((track, iIdx) => (
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
                      {track.title || track.originalFilename}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      original file: {track.originalFilename}
                    </Typography>
                  </Box>
                  {value.sessions.length > 0 ? (
                    <Select
                      size="small"
                      displayEmpty
                      value=""
                      onChange={(e) =>
                        restoreTrack(iIdx, Number(e.target.value))
                      }
                      inputProps={{ "aria-label": "Restore track to session" }}
                      sx={{ width: 190 }}
                    >
                      <MenuItem value="" disabled>
                        Restore to…
                      </MenuItem>
                      {value.sessions.map((_, i) => (
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

      {/* AI title-cleanup box */}
      {enableAiRename && (
        <Box
          sx={{
            px: 2,
            pb: 2,
            display: "flex",
            gap: 1,
            alignItems: "flex-start",
          }}
        >
          <TextField
            fullWidth
            size="small"
            multiline
            maxRows={3}
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
            sx={{ mt: 0.5, flexShrink: 0 }}
          >
            {applyingAi ? "Applying…" : "Apply AI"}
          </Button>
        </Box>
      )}
    </Paper>
  );
}
