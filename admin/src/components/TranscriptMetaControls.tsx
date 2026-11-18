/**
 * Per-file transcript metadata on the event page: language, revision status,
 * excerpts flag and the publish switch, plus the page count read-only.
 *
 * Each control saves on its own with a PATCH that carries only the field that
 * changed, so two quick edits (or a stale copy of the row) never overwrite each
 * other. The status only describes the file; the switch alone decides whether
 * readers see it.
 */
import { useEffect, useState } from "react";
import { useNotify, useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import NativeSelect from "@mui/material/NativeSelect";
import OutlinedInput from "@mui/material/OutlinedInput";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import VisibilityOffOutlinedIcon from "@mui/icons-material/VisibilityOffOutlined";
import { authFetch } from "../utils/authFetch";

export const TRANSCRIPT_LANGUAGES = ["en", "pt", "fr", "tib"] as const;
export const TRANSCRIPT_STATUSES = ["final", "provisional", "unrevised", "draft"] as const;

export interface TranscriptMeta {
  language: string;
  status: string;
  isExcerpt: boolean;
  published: boolean;
}

type MetaField = keyof TranscriptMeta;

const STATUS_LABEL_KEYS: Record<string, string> = {
  final: "padmakara.transcript.statusFinal",
  provisional: "padmakara.transcript.statusProvisional",
  unrevised: "padmakara.transcript.statusUnrevised",
  draft: "padmakara.transcript.statusDraft",
};

async function patchTranscript(id: number, patch: Partial<TranscriptMeta>): Promise<void> {
  const res = await authFetch(`/api/admin/transcripts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

interface TranscriptMetaControlsProps {
  transcriptId: number;
  meta: TranscriptMeta;
  pageCount: number | null;
}

/** Test id and accessible name for the <select>; MUI's input props type omits data-* keys. */
function selectAttributes(testId: string, label: string): Record<string, string> {
  return { "data-testid": testId, "aria-label": label };
}

const compactInput =<OutlinedInput size="small" sx={{ fontSize: "0.75rem", "& select": { py: 0.5 } }} />;
const smallLabelSx = { mr: 0, "& .MuiFormControlLabel-label": { fontSize: "0.75rem" } } as const;

export const TranscriptMetaControls = ({ transcriptId, meta: saved, pageCount }: TranscriptMetaControlsProps) => {
  const translate = useTranslate();
  const notify = useNotify();
  const [meta, setMeta] = useState<TranscriptMeta>(saved);

  // A reload of the event (after an upload or a delete) brings the stored values back in.
  // Keyed on the values, not the object, which the parent rebuilds on every render.
  const { language, status, isExcerpt, published } = saved;
  useEffect(() => {
    setMeta({ language, status, isExcerpt, published });
  }, [language, status, isExcerpt, published]);

  const save = async <K extends MetaField>(field: K, value: TranscriptMeta[K]) => {
    const previous = meta[field];
    if (previous === value) return;
    setMeta((m) => ({ ...m, [field]: value }));
    try {
      await patchTranscript(transcriptId, { [field]: value } as Partial<TranscriptMeta>);
    } catch (err: unknown) {
      setMeta((m) => ({ ...m, [field]: previous }));
      const msg = err instanceof Error ? err.message : String(err);
      notify(`${translate("padmakara.transcript.updateFailed") || "Failed to update transcript"}: ${msg}`, {
        type: "error",
      });
    }
  };

  // A legacy value (e.g. "unknown") stays visible rather than silently showing as EN
  const languages: string[] = TRANSCRIPT_LANGUAGES.includes(meta.language as (typeof TRANSCRIPT_LANGUAGES)[number])
    ? [...TRANSCRIPT_LANGUAGES]
    : [meta.language, ...TRANSCRIPT_LANGUAGES];

  return (
    <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.5, pl: 3.5, pt: 0.5 }}>
      <NativeSelect
        value={meta.language}
        onChange={(e) => void save("language", e.target.value)}
        input={compactInput}
        inputProps={selectAttributes(`transcript-language-${transcriptId}`, translate("padmakara.transcript.language") || "Language")}
      >
        {languages.map((code) => (
          <option key={code} value={code}>{code.toUpperCase()}</option>
        ))}
      </NativeSelect>

      <NativeSelect
        value={meta.status}
        onChange={(e) => void save("status", e.target.value)}
        input={compactInput}
        inputProps={selectAttributes(`transcript-status-${transcriptId}`, translate("padmakara.transcript.status") || "Status")}
      >
        {TRANSCRIPT_STATUSES.map((status) => (
          <option key={status} value={status}>{translate(STATUS_LABEL_KEYS[status]!) || status}</option>
        ))}
      </NativeSelect>

      <FormControlLabel
        sx={smallLabelSx}
        control={
          <Checkbox
            size="small"
            checked={meta.isExcerpt}
            onChange={(e) => void save("isExcerpt", e.target.checked)}
            slotProps={{ input: { "data-testid": `transcript-excerpt-${transcriptId}` } as React.InputHTMLAttributes<HTMLInputElement> }}
          />
        }
        label={translate("padmakara.transcript.excerpts") || "Excerpts"}
      />

      <FormControlLabel
        sx={smallLabelSx}
        control={
          <Switch
            size="small"
            checked={meta.published}
            onChange={(e) => void save("published", e.target.checked)}
            slotProps={{ input: { "data-testid": `transcript-published-${transcriptId}` } as React.InputHTMLAttributes<HTMLInputElement> }}
          />
        }
        label={translate("padmakara.transcript.published") || "Published"}
      />

      {!meta.published && (
        <Chip
          icon={<VisibilityOffOutlinedIcon sx={{ fontSize: "14px !important" }} />}
          label={translate("padmakara.transcript.unpublished") || "Unpublished"}
          size="small"
          color="warning"
          variant="outlined"
          sx={{ height: 22, "& .MuiChip-label": { fontSize: "0.7rem", px: 0.75 } }}
        />
      )}

      {pageCount != null && (
        <Typography
          variant="caption"
          data-testid={`transcript-pages-${transcriptId}`}
          sx={{ color: "text.secondary", fontSize: "0.7rem" }}
        >
          {pageCount} {translate("padmakara.transcript.pageUnit", { smart_count: pageCount }) || "pages"}
        </Typography>
      )}
    </Box>
  );
};
