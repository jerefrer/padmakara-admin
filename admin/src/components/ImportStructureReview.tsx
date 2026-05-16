import { useCallback, useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import Autocomplete from "@mui/material/Autocomplete";
import type { ProposedStructure, ProposedTrack } from "../utils/migrationApi";

interface ImportStructureReviewProps {
  value: ProposedStructure;
  onChange: (next: ProposedStructure) => void;
  /** DB teachers, used to populate the per-track speaker combobox. */
  teachers: { id: number; name: string; abbreviation: string }[];
}

const TIME_PERIODS = ["morning", "afternoon"];

/** A draft always carries `ignored` — `update()` normalises it before mutating. */
type DraftStructure = ProposedStructure & { ignored: ProposedTrack[] };

/**
 * Controlled editor for an AI-proposed import structure. The human can fix
 * session metadata, track titles/speakers, move tracks between sessions to
 * correct the AI's grouping, and set tracks aside as "ignored" (excluded from
 * the import — e.g. a duplicate). Ignored tracks live in a collapsible section
 * and can be restored into any session. Empty sessions are left visible (so
 * tracks can be moved into a freshly added one); the parent drops empties and
 * renumbers when the structure is confirmed.
 */
export function ImportStructureReview({
  value,
  onChange,
  teachers,
}: ImportStructureReviewProps) {
  const [ignoredOpen, setIgnoredOpen] = useState(false);

  const update = useCallback(
    (mutate: (draft: DraftStructure) => void) => {
      // structuredClone keeps an existing `ignored`; we then normalise a
      // missing one (pre-ignore-feature data) to [] so every mutate handler
      // can rely on it — which is what the DraftStructure cast asserts.
      const draft = structuredClone(value) as DraftStructure;
      if (!Array.isArray(draft.ignored)) draft.ignored = [];
      mutate(draft);
      onChange(draft);
    },
    [value, onChange],
  );

  const moveTrack = useCallback(
    (fromIdx: number, trackIdx: number, toIdx: number) => {
      if (fromIdx === toIdx) return;
      update((draft) => {
        const from = draft.sessions[fromIdx];
        const to = draft.sessions[toIdx];
        if (!from || !to) return;
        const [track] = from.tracks.splice(trackIdx, 1);
        if (track) to.tracks.push(track);
      });
    },
    [update],
  );

  const addSession = useCallback(() => {
    update((draft) => {
      draft.sessions.push({
        sessionNumber: draft.sessions.length + 1,
        titleEn: "New session",
        sessionDate: null,
        timePeriod: "morning",
        tracks: [],
      });
    });
  }, [update]);

  const ignoreTrack = useCallback(
    (sIdx: number, trackIdx: number) => {
      update((draft) => {
        const session = draft.sessions[sIdx];
        if (!session) return;
        const [track] = session.tracks.splice(trackIdx, 1);
        if (track) draft.ignored.push(track);
      });
    },
    [update],
  );

  const restoreTrack = useCallback(
    (ignoredIdx: number, toSessionIdx: number) => {
      update((draft) => {
        const target = draft.sessions[toSessionIdx];
        if (!target) return;
        const [track] = draft.ignored.splice(ignoredIdx, 1);
        if (track) target.tracks.push(track);
      });
    },
    [update],
  );

  const ignored = value.ignored ?? [];

  return (
    <Box>
      {value.sessions.map((session, sIdx) => (
        <Paper key={sIdx} variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Box
            sx={{ display: "flex", gap: 1, alignItems: "center", mb: 1.5 }}
          >
            <Chip label={`Session ${sIdx + 1}`} size="small" />
            <TextField
              label="Title"
              size="small"
              value={session.titleEn}
              onChange={(e) =>
                update((d) => {
                  const s = d.sessions[sIdx];
                  if (s) s.titleEn = e.target.value;
                })
              }
              sx={{ flex: 1 }}
            />
            <TextField
              label="Date (YYYY-MM-DD)"
              size="small"
              value={session.sessionDate ?? ""}
              onChange={(e) =>
                update((d) => {
                  const s = d.sessions[sIdx];
                  if (s) s.sessionDate = e.target.value || null;
                })
              }
              sx={{ width: 170 }}
            />
            <Select
              size="small"
              value={session.timePeriod}
              onChange={(e) =>
                update((d) => {
                  const s = d.sessions[sIdx];
                  if (s) s.timePeriod = String(e.target.value);
                })
              }
              sx={{ width: 140 }}
            >
              {TIME_PERIODS.map((p) => (
                <MenuItem key={p} value={p}>
                  {p}
                </MenuItem>
              ))}
            </Select>
          </Box>

          {session.tracks.length === 0 && (
            <Typography variant="caption" color="text.secondary">
              No tracks — move tracks here, or this empty session is dropped on
              confirm.
            </Typography>
          )}

          {session.tracks.map((track, tIdx) => (
            <Box
              key={track.importFileId}
              sx={{ mb: 1, pl: 1, borderLeft: "2px solid", borderColor: "divider" }}
            >
              <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                <TextField
                  size="small"
                  type="number"
                  label="#"
                  value={track.trackNumber}
                  onChange={(e) =>
                    update((d) => {
                      const t = d.sessions[sIdx]?.tracks[tIdx];
                      if (t) t.trackNumber = Number.parseInt(e.target.value, 10) || 0;
                    })
                  }
                  sx={{ width: 72 }}
                />
                <TextField
                  size="small"
                  value={track.title}
                  onChange={(e) =>
                    update((d) => {
                      const t = d.sessions[sIdx]?.tracks[tIdx];
                      if (t) t.title = e.target.value;
                    })
                  }
                  sx={{ flex: 1 }}
                />
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
                    <TextField {...params} label="Speaker" />
                  )}
                  sx={{ width: 150 }}
                />
                {track.isTranslation && (
                  <Chip label="translation" size="small" variant="outlined" />
                )}
                <Select
                  size="small"
                  value={sIdx}
                  onChange={(e) =>
                    moveTrack(sIdx, tIdx, Number(e.target.value))
                  }
                  inputProps={{ "aria-label": "Move track to a session" }}
                  sx={{ width: 170 }}
                >
                  {value.sessions.map((_, i) => (
                    <MenuItem key={i} value={i}>
                      {i === sIdx
                        ? "— this session —"
                        : `Move to session ${i + 1}`}
                    </MenuItem>
                  ))}
                </Select>
                <Button
                  size="small"
                  color="warning"
                  onClick={() => ignoreTrack(sIdx, tIdx)}
                >
                  Ignore
                </Button>
              </Box>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", pl: "36px", mt: 0.25 }}
              >
                original file: {track.originalFilename}
              </Typography>
            </Box>
          ))}
        </Paper>
      ))}
      <Button onClick={addSession} variant="outlined" size="small">
        + Add session
      </Button>

      {ignored.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Button
            size="small"
            color="inherit"
            onClick={() => setIgnoredOpen((open) => !open)}
          >
            {ignoredOpen ? "▾" : "▸"} Ignored files ({ignored.length})
          </Button>
          <Collapse in={ignoredOpen}>
            <Paper variant="outlined" sx={{ p: 2, mt: 1 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mb: 1 }}
              >
                These tracks are excluded from the import. Restore one to put it
                back into a session.
              </Typography>
              {ignored.map((track, iIdx) => (
                <Box
                  key={track.importFileId}
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
                  {track.isTranslation && (
                    <Chip label="translation" size="small" variant="outlined" />
                  )}
                  {value.sessions.length > 0 ? (
                    <Select
                      size="small"
                      displayEmpty
                      value=""
                      onChange={(e) =>
                        restoreTrack(iIdx, Number(e.target.value))
                      }
                      inputProps={{
                        "aria-label": "Restore track to a session",
                      }}
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
    </Box>
  );
}
