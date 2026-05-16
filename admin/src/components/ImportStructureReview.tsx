import { useCallback } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import type { ProposedStructure } from "../utils/importApi";

interface ImportStructureReviewProps {
  value: ProposedStructure;
  onChange: (next: ProposedStructure) => void;
}

const TIME_PERIODS = ["morning", "afternoon", "evening"];

/**
 * Controlled editor for an AI-proposed import structure. The human can fix
 * session metadata, track titles/speakers, and — most importantly — move
 * tracks between sessions to correct the AI's grouping. Empty sessions are
 * left visible (so tracks can be moved into a freshly added one); the parent
 * drops empties and renumbers when the structure is confirmed.
 */
export function ImportStructureReview({
  value,
  onChange,
}: ImportStructureReviewProps) {
  const update = useCallback(
    (mutate: (draft: ProposedStructure) => void) => {
      const draft = structuredClone(value);
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
              sx={{
                display: "flex",
                gap: 1,
                alignItems: "center",
                mb: 0.5,
              }}
            >
              <Typography
                variant="caption"
                sx={{ width: 28, textAlign: "right" }}
              >
                {track.trackNumber}
              </Typography>
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
              <TextField
                size="small"
                label="Speaker"
                value={track.speaker ?? ""}
                onChange={(e) =>
                  update((d) => {
                    const t = d.sessions[sIdx]?.tracks[tIdx];
                    if (t) t.speaker = e.target.value || null;
                  })
                }
                sx={{ width: 120 }}
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
            </Box>
          ))}
        </Paper>
      ))}
      <Button onClick={addSession} variant="outlined" size="small">
        + Add session
      </Button>
    </Box>
  );
}
