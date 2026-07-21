import { useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useNotify, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";

export interface AiAssistEventFields {
  titleEn?: string; titlePt?: string;
  mainThemesEn?: string; mainThemesPt?: string;
  sessionThemesEn?: string; sessionThemesPt?: string;
  startDate?: string; endDate?: string;
}
export interface AiAssistTrack {
  rowKey: string; originalFilename: string; title: string;
  titleEn?: string; titlePt?: string; speaker?: string | null;
}
export interface AiAssistSession { rowKey: string; titleEn?: string; titlePt?: string; }
export interface AiAssistResult {
  event?: AiAssistEventFields;
  sessions: Array<{ rowKey: string; titleEn?: string; titlePt?: string }>;
  tracks: Array<{ rowKey: string; titleEn?: string; titlePt?: string; speaker?: string; speakerUnmatched?: true }>;
}
interface AiAssistPanelProps {
  event: AiAssistEventFields;
  sessions: AiAssistSession[];
  tracks: AiAssistTrack[];
  endpoint: string;
  onApply: (result: AiAssistResult) => void | Promise<void>;
}

interface DiffRow { label: string; from: string; to: string; unmatched?: boolean; }

// Every AiAssistEventFields key already has a human-readable label in
// padmakara.events.* (the event details form uses the same fields), so the
// diff review reuses those instead of rendering raw camelCase field names.
const EVENT_FIELD_LABEL_KEYS: Record<keyof AiAssistEventFields, string> = {
  titleEn: "padmakara.events.titleEn",
  titlePt: "padmakara.events.titlePt",
  mainThemesEn: "padmakara.events.mainThemesEn",
  mainThemesPt: "padmakara.events.mainThemesPt",
  sessionThemesEn: "padmakara.events.sessionThemesEn",
  sessionThemesPt: "padmakara.events.sessionThemesPt",
  startDate: "padmakara.events.startDate",
  endDate: "padmakara.events.endDate",
};

export function AiAssistPanel({ event, sessions, tracks, endpoint, onApply }: AiAssistPanelProps) {
  const translate = useTranslate();
  const notify = useNotify();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<AiAssistResult | null>(null);

  const t = (k: string) => translate(`padmakara.aiAssist.${k}`);

  const trackByKey = useMemo(
    () => new Map(tracks.map((tr) => [tr.rowKey, tr])),
    [tracks],
  );
  const sessionByKey = useMemo(
    () => new Map(sessions.map((s) => [s.rowKey, s])),
    [sessions],
  );

  const eventDiffs = useMemo<DiffRow[]>(() => {
    if (!result?.event) return [];
    // Object.keys() widens to string[]; AiAssistEventFields has no other own
    // keys, so every runtime key is guaranteed to be one of its keyof.
    return (Object.keys(result.event) as (keyof AiAssistEventFields)[]).map((k) => ({
      label: translate(EVENT_FIELD_LABEL_KEYS[k]),
      from: event[k] ?? "",
      // Non-null: the early return above guarantees result.event is defined;
      // TS can't carry that narrowing through this .map() callback closure.
      to: result.event![k] ?? "",
    }));
  }, [result, event, translate]);

  const sessionDiffs = useMemo<DiffRow[]>(() => {
    if (!result) return [];
    return result.sessions.flatMap((s) => {
      const cur = sessionByKey.get(s.rowKey);
      const rows: DiffRow[] = [];
      if (s.titleEn !== undefined) rows.push({ label: `EN`, from: cur?.titleEn ?? "", to: s.titleEn });
      if (s.titlePt !== undefined) rows.push({ label: `PT`, from: cur?.titlePt ?? "", to: s.titlePt });
      return rows;
    });
  }, [result, sessionByKey]);

  const trackDiffs = useMemo<DiffRow[]>(() => {
    if (!result) return [];
    return result.tracks.flatMap((tr) => {
      const cur = trackByKey.get(tr.rowKey);
      const trackLabel = cur?.title || cur?.originalFilename || tr.rowKey;
      const rows: DiffRow[] = [];
      if (tr.titleEn !== undefined) {
        rows.push({
          label: `${trackLabel} · EN`,
          from: cur?.titleEn ?? "",
          to: tr.titleEn,
        });
      }
      if (tr.titlePt !== undefined) {
        rows.push({
          label: `${trackLabel} · PT`,
          from: cur?.titlePt ?? "",
          to: tr.titlePt,
        });
      }
      if (tr.speaker !== undefined) {
        rows.push({
          label: translate("padmakara.fields.speaker"),
          from: cur?.speaker ?? "",
          to: tr.speaker,
          unmatched: tr.speakerUnmatched,
        });
      }
      return rows;
    });
  }, [result, trackByKey, translate]);

  const totalChanges = eventDiffs.length + sessionDiffs.length + trackDiffs.length;

  const handleAsk = async () => {
    const text = instruction.trim();
    if (!text) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await authFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: text, event, sessions, tracks }),
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
      setResult({ event: data.event, sessions: data.sessions ?? [], tracks: data.tracks ?? [] });
    } catch (e) {
      // authFetch rejects/throws only Error instances here
      notify(`${t("failed")}: ${(e as Error).message}`, { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!result || applying) return;
    setApplying(true);
    try {
      await onApply(result);
      setResult(null);
      setInstruction("");
      notify(t("applied"), { type: "info" });
    } finally {
      setApplying(false);
    }
  };

  const renderDiffs = (title: string, rows: DiffRow[]) =>
    rows.length > 0 && (
      <Box sx={{ mb: 1.5 }}>
        <Typography variant="caption" sx={{ fontWeight: 700, textTransform: "uppercase", opacity: 0.7 }}>
          {title}
        </Typography>
        {rows.map((r, i) => (
          <Box key={i} sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap", py: 0.25 }}>
            <Typography variant="body2" sx={{ minWidth: 120, opacity: 0.8 }}>{r.label}</Typography>
            <Typography variant="body2" sx={{ textDecoration: "line-through", opacity: 0.6 }}>{r.from || "—"}</Typography>
            <Typography variant="body2">→</Typography>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>{r.to || "—"}</Typography>
            {r.unmatched && <Chip size="small" color="warning" label={t("unmatchedSpeaker")} />}
          </Box>
        ))}
      </Box>
    );

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
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>{t("reviewTitle")}</Typography>
          {totalChanges === 0 ? (
            <Typography variant="body2" color="text.secondary">{t("noChanges")}</Typography>
          ) : (
            <>
              {renderDiffs(t("sectionEvent"), eventDiffs)}
              {renderDiffs(t("sectionSessions"), sessionDiffs)}
              {renderDiffs(t("sectionTracks"), trackDiffs)}
              <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
                <Button
                  variant="contained" size="small"
                  onClick={() => void handleApply()}
                  disabled={applying}
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
