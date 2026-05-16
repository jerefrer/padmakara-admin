import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import type { ProposedTranscript } from "../utils/migrationApi";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "pt", label: "Portuguese" },
];

interface ImportTranscriptsPanelProps {
  value: ProposedTranscript[];
  onChange: (next: ProposedTranscript[]) => void;
}

/**
 * Controlled editor for the transcript PDFs of an import job. Each cataloged
 * PDF is listed with a language picker that defaults to English (every legacy
 * transcript is English); the reviewer can change it on the rare occasion a
 * transcript is in another language. Every listed PDF is imported.
 */
export function ImportTranscriptsPanel({
  value,
  onChange,
}: ImportTranscriptsPanelProps) {
  if (value.length === 0) return null;

  return (
    <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Transcripts ({value.length})
      </Typography>
      {value.map((transcript, idx) => {
        // Keep the row's current language selectable even if it is not one of
        // the standard options (defensive — proposals always default to "en").
        const options = LANGUAGES.some((l) => l.code === transcript.language)
          ? LANGUAGES
          : [...LANGUAGES, { code: transcript.language, label: transcript.language }];
        return (
          <Box
            key={transcript.importFileId}
            sx={{ display: "flex", gap: 1, alignItems: "center", mb: 1 }}
          >
            <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
              {transcript.originalFilename}
            </Typography>
            <Select
              size="small"
              value={transcript.language}
              onChange={(e) =>
                onChange(
                  value.map((t, i) =>
                    i === idx
                      ? { ...t, language: String(e.target.value) }
                      : t,
                  ),
                )
              }
              inputProps={{ "aria-label": "Transcript language" }}
              sx={{ width: 150 }}
            >
              {options.map((lang) => (
                <MenuItem key={lang.code} value={lang.code}>
                  {lang.label}
                </MenuItem>
              ))}
            </Select>
          </Box>
        );
      })}
    </Paper>
  );
}
