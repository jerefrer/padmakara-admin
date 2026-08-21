import { useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Checkbox from "@mui/material/Checkbox";
import Divider from "@mui/material/Divider";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useNotify, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";
import {
  buildEventDiffs,
  buildSessionDiffs,
  buildTrackDiffs,
  buildVideoDiffs,
  selectedResult,
  type AiAssistEventFields,
  type AiAssistResult,
  type AiAssistSession,
  type AiAssistTrack,
  type AiAssistVideo,
  type DiffRow,
  type Segment,
} from "../utils/aiAssistDiff";

export type {
  AiAssistEventFields,
  AiAssistResult,
  AiAssistSession,
  AiAssistTrack,
  AiAssistVideo,
};

interface AiAssistPanelProps {
  event: AiAssistEventFields;
  sessions: AiAssistSession[];
  // Absent for the create flow — a video needs a real event id to attach to,
  // so there is nothing to send until the event has been saved.
  videos?: AiAssistVideo[];
  tracks: AiAssistTrack[];
  endpoint: string;
  onApply: (result: AiAssistResult) => void | Promise<void>;
}

/** Beyond this the review scrolls in place, so Apply stays reachable. */
const REVIEW_MAX_HEIGHT = 420;

/**
 * A value with the words that moved picked out, so a one-word correction in a
 * long title doesn't have to be found by comparing two sentences by eye.
 * `side` decides whether a flagged run reads as removed or as added.
 */
function InlineValue({ segments, side }: { segments: Segment[]; side: "from" | "to" }) {
  if (segments.length === 0) return <>—</>;
  return (
    <>
      {segments.map((seg, i) =>
        seg.changed ? (
          <Box
            key={i}
            component="span"
            sx={
              side === "from"
                ? {
                    backgroundColor: "rgba(211,47,47,0.12)",
                    textDecoration: "line-through",
                    borderRadius: 0.5,
                  }
                : { backgroundColor: "rgba(46,125,50,0.16)", fontWeight: 700, borderRadius: 0.5 }
            }
          >
            {seg.text}
          </Box>
        ) : (
          <Box key={i} component="span">{seg.text}</Box>
        ),
      )}
    </>
  );
}

export function AiAssistPanel({ event, sessions, videos = [], tracks, endpoint, onApply }: AiAssistPanelProps) {
  const translate = useTranslate();
  const notify = useNotify();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<AiAssistResult | null>(null);
  // Ids of rows the admin has unticked. Tracking exclusions rather than
  // selections means a fresh reply arrives fully selected with no sync step.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());

  const t = (k: string, options?: Record<string, unknown>) =>
    translate(`padmakara.aiAssist.${k}`, options);

  const eventDiffs = useMemo(
    () => buildEventDiffs(event, result?.event, translate),
    [result, event, translate],
  );
  const sessionDiffs = useMemo(
    () => (result ? buildSessionDiffs(sessions, result.sessions, translate) : []),
    [result, sessions, translate],
  );
  const videoDiffs = useMemo(
    () => (result ? buildVideoDiffs(videos, result.videos, translate) : []),
    [result, videos, translate],
  );
  const trackDiffs = useMemo(
    () => (result ? buildTrackDiffs(tracks, result.tracks, translate) : []),
    [result, tracks, translate],
  );

  const allDiffs = useMemo(
    () => [...eventDiffs, ...sessionDiffs, ...videoDiffs, ...trackDiffs],
    [eventDiffs, sessionDiffs, videoDiffs, trackDiffs],
  );
  const totalChanges = allDiffs.length;
  const selectedCount = allDiffs.filter((r) => !excluded.has(r.id)).length;

  const setRowsExcluded = (ids: readonly string[], exclude: boolean) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (exclude) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const handleAsk = async () => {
    const text = instruction.trim();
    if (!text) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await authFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The admin's own numbering goes along with the rows: it is what an
        // instruction like "retitle tracks 3 to 7" is resolved against, and
        // without it the model can only guess from filenames. Videos are
        // renumbered 1-based here because that is how the admin labels them.
        body: JSON.stringify({
          instruction: text,
          event,
          sessions,
          videos: videos.map(({ position, ...rest }) => ({ ...rest, videoNumber: position + 1 })),
          tracks,
        }),
      });
      if (!res.ok) {
        // Prefer the API's `error` field (e.g. the friendly AI_UNAVAILABLE
        // message) over the raw JSON body, falling back to the body then the
        // status when it isn't the expected shape.
        const body = await res.text();
        let message = body || `${res.status}`;
        try {
          const parsed = JSON.parse(body) as { error?: unknown };
          if (typeof parsed.error === "string" && parsed.error) message = parsed.error;
        } catch {
          /* non-JSON body — show it as-is */
        }
        throw new Error(message);
      }
      // Trusting the shape here: the rename-tracks endpoint's contract
      // (Tasks 1-2) guarantees { event?, sessions, tracks } on success.
      const data = (await res.json()) as AiAssistResult;
      setExcluded(new Set());
      setResult({ event: data.event, sessions: data.sessions ?? [], videos: data.videos ?? [], tracks: data.tracks ?? [] });
    } catch (e) {
      // authFetch rejects/throws only Error instances here
      notify(`${t("failed")}: ${(e as Error).message}`, { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!result || applying || selectedCount === 0) return;
    setApplying(true);
    try {
      await onApply(selectedResult(result, allDiffs, excluded));
      setResult(null);
      setExcluded(new Set());
      setInstruction("");
      notify(t("applied"), { type: "info" });
    } finally {
      setApplying(false);
    }
  };

  /**
   * One section of the review, as a table: what changed on the left, the
   * current value and the proposal in their own columns so a long title in
   * one row can't push the next row's values out of alignment. Every row —
   * and every session heading — carries a checkbox, so a suggestion that went
   * too wide can be trimmed instead of thrown away wholesale.
   */
  const renderDiffs = (title: string, itemHeader: string, rows: DiffRow[]) => {
    if (rows.length === 0) return null;
    // Event rows name a field outright and have nothing to identify.
    const showItem = rows.some((r) => r.itemLabel !== "");
    const columns = showItem ? 5 : 4;

    const sectionIds = rows.map((r) => r.id);
    // Ids per session heading, so one tick can clear a whole session.
    const groupIds = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.groupLabel) continue;
      const list = groupIds.get(r.groupLabel);
      if (list) list.push(r.id);
      else groupIds.set(r.groupLabel, [r.id]);
    }

    const selectionProps = (ids: readonly string[]) => {
      const on = ids.filter((id) => !excluded.has(id)).length;
      return {
        checked: on === ids.length,
        indeterminate: on > 0 && on < ids.length,
        onChange: (e: ChangeEvent<HTMLInputElement>) =>
          setRowsExcluded(ids, !e.target.checked),
      };
    };

    const body: ReactNode[] = [];
    let lastGroup: string | undefined;
    let lastItem: string | undefined;

    rows.forEach((r, i) => {
      if (r.groupLabel && r.groupLabel !== lastGroup) {
        lastGroup = r.groupLabel;
        // A new session restarts the item runs beneath it.
        lastItem = undefined;
        const ids = groupIds.get(r.groupLabel) ?? [];
        body.push(
          <TableRow key={`group-${i}`}>
            <TableCell
              padding="checkbox"
              sx={{ py: 0.25, borderBottom: "none", backgroundColor: "rgba(91,94,166,0.05)" }}
            >
              <Checkbox size="small" {...selectionProps(ids)} />
            </TableCell>
            <TableCell
              colSpan={columns - 1}
              sx={{
                py: 0.5, borderBottom: "none",
                fontWeight: 700, fontSize: "0.72rem", letterSpacing: 0.3,
                color: "text.secondary", backgroundColor: "rgba(91,94,166,0.05)",
              }}
            >
              {r.groupLabel}
            </TableCell>
          </TableRow>,
        );
      }
      const startsItem = r.itemKey !== lastItem;
      lastItem = r.itemKey;
      const off = excluded.has(r.id);
      // Only the first row of an item repeats its label; a hairline above it
      // keeps the grouping readable without drawing a full grid.
      const cellSx = {
        py: 0.4,
        verticalAlign: "top" as const,
        borderBottom: "none",
        borderTop: startsItem && body.length > 0 ? "1px solid rgba(0,0,0,0.05)" : "none",
        opacity: off ? 0.4 : 1,
      };
      body.push(
        <TableRow key={`row-${i}`} hover>
          <TableCell sx={{ ...cellSx, opacity: 1 }} padding="checkbox">
            <Checkbox
              size="small"
              checked={!off}
              onChange={(e) => setRowsExcluded([r.id], !e.target.checked)}
            />
          </TableCell>
          {showItem && (
            <TableCell sx={{ ...cellSx, width: 150 }}>
              {startsItem && (
                <>
                  <Typography variant="body2" sx={{ fontFamily: "monospace", fontWeight: 600 }}>
                    {r.itemLabel}
                  </Typography>
                  {r.itemSubLabel && (
                    <Typography
                      variant="caption"
                      sx={{ display: "block", color: "text.secondary", wordBreak: "break-word" }}
                    >
                      {r.itemSubLabel}
                    </Typography>
                  )}
                </>
              )}
            </TableCell>
          )}
          <TableCell sx={{ ...cellSx, width: showItem ? 110 : 180 }}>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>{r.field}</Typography>
          </TableCell>
          <TableCell sx={{ ...cellSx, width: "35%" }}>
            <Typography variant="body2" sx={{ opacity: 0.75, wordBreak: "break-word" }}>
              <InlineValue segments={r.fromSegments} side="from" />
            </Typography>
          </TableCell>
          <TableCell sx={cellSx}>
            <Typography variant="body2" sx={{ wordBreak: "break-word" }}>
              <InlineValue segments={r.toSegments} side="to" />
            </Typography>
            {r.unmatched && (
              <Chip size="small" color="warning" label={t("unmatchedSpeaker")} sx={{ mt: 0.25 }} />
            )}
          </TableCell>
        </TableRow>,
      );
    });

    return (
      <Box sx={{ mb: 2 }}>
        <Typography variant="caption" sx={{ fontWeight: 700, textTransform: "uppercase", opacity: 0.7 }}>
          {title}
        </Typography>
        <Table
          size="small"
          sx={{
            mt: 0.5,
            tableLayout: "fixed",
            "& th": {
              py: 0.5, borderBottom: "1px solid rgba(0,0,0,0.12)",
              fontWeight: 700, fontSize: "0.68rem", textTransform: "uppercase",
              letterSpacing: 0.4, color: "text.secondary",
            },
          }}
        >
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox size="small" {...selectionProps(sectionIds)} />
              </TableCell>
              {showItem && <TableCell sx={{ width: 150 }}>{itemHeader}</TableCell>}
              <TableCell sx={{ width: showItem ? 110 : 180 }}>{t("colField")}</TableCell>
              <TableCell sx={{ width: "35%" }}>{t("colCurrent")}</TableCell>
              <TableCell>{t("colProposed")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>{body}</TableBody>
        </Table>
      </Box>
    );
  };

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2, mb: 2,
        borderColor: "rgba(91,94,166,0.35)",
        background: "linear-gradient(135deg, rgba(91,94,166,0.07), rgba(91,94,166,0.02))",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.25 }}>
        <AutoAwesomeIcon sx={{ color: "primary.main", fontSize: 20 }} />
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{t("heading")}</Typography>
        <Typography variant="caption" color="text.secondary">{t("caption")}</Typography>
      </Box>
      <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
        <TextField
          fullWidth size="small" multiline minRows={3} maxRows={6}
          placeholder={t("placeholder")}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={busy}
          sx={{ backgroundColor: "background.paper", borderRadius: 1 }}
        />
        <Button
          variant="contained" startIcon={<AutoAwesomeIcon />}
          onClick={() => void handleAsk()}
          disabled={busy || instruction.trim() === ""}
          sx={{ flexShrink: 0, minWidth: 120, textTransform: "none", borderRadius: 2 }}
        >
          {busy ? t("thinking") : t("ask")}
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
        {t("batchHint")}
      </Typography>

      {result && (
        <Box sx={{ mt: 2 }}>
          <Divider sx={{ mb: 1.5 }} />
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{t("reviewTitle")}</Typography>
            {totalChanges > 0 && (
              <Chip
                size="small"
                color={selectedCount === 0 ? "default" : "primary"}
                variant={selectedCount === totalChanges ? "filled" : "outlined"}
                label={
                  selectedCount === totalChanges
                    ? t("changeCount", { smart_count: totalChanges })
                    : t("changeCountSelected", { selected: selectedCount, total: totalChanges })
                }
              />
            )}
          </Box>
          {totalChanges === 0 ? (
            <Typography variant="body2" color="text.secondary">{t("noChanges")}</Typography>
          ) : (
            <>
              {/* Scrolls in place so a few hundred track rows can't push the
                  Apply button off the bottom of the page. */}
              <Box
                sx={{
                  maxHeight: REVIEW_MAX_HEIGHT, overflowY: "auto",
                  backgroundColor: "background.paper",
                  border: "1px solid rgba(0,0,0,0.08)", borderRadius: 1,
                  px: 1.5, py: 1, mb: 1.5,
                }}
              >
                {renderDiffs(t("sectionEvent"), "", eventDiffs)}
                {renderDiffs(t("sectionSessions"), t("colSession"), sessionDiffs)}
                {renderDiffs(t("sectionVideos"), t("colVideo"), videoDiffs)}
                {renderDiffs(t("sectionTracks"), t("colTrack"), trackDiffs)}
              </Box>
              <Box sx={{ display: "flex", gap: 1 }}>
                <Button
                  variant="contained" size="small"
                  onClick={() => void handleApply()}
                  disabled={applying || selectedCount === 0}
                  sx={{ textTransform: "none" }}
                >
                  {applying ? t("applying") : t("apply")}
                </Button>
                <Button variant="text" size="small" onClick={() => setResult(null)} sx={{ textTransform: "none" }}>
                  {t("discard")}
                </Button>
              </Box>
            </>
          )}
        </Box>
      )}
    </Paper>
  );
}
