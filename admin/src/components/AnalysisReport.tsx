import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { useTranslate } from "react-admin";
import type { AnalysisResult } from "../utils/analyzeFolder";

interface AnalysisReportProps {
  notes: AnalysisResult["notes"];
  aiCoverage: AnalysisResult["aiCoverage"];
  onRetryAi?: () => void;
}

/**
 * Purely presentational panel that renders:
 * - A warning banner when AI analysis was unavailable (full or partial fallback)
 * - An AI notes section listing info/warning messages from the analysis
 *
 * When AI succeeded fully and notes is empty, renders nothing.
 */
export function AnalysisReport({ notes, aiCoverage, onRetryAi }: AnalysisReportProps) {
  const t = useTranslate();

  const aiDegraded =
    aiCoverage.tracksAnalyzedByAi === 0 || aiCoverage.chunksFailed > 0;

  if (!aiDegraded && notes.length === 0) return null;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {aiDegraded && (
        <Alert
          severity="warning"
          icon={<AutoFixHighIcon />}
          action={
            onRetryAi ? (
              <Button
                variant="contained"
                color="warning"
                size="small"
                onClick={onRetryAi}
                startIcon={<AutoFixHighIcon />}
                sx={{ alignSelf: "center", whiteSpace: "nowrap" }}
              >
                {t("padmakara.import.retryAi") || "Retry AI analysis"}
              </Button>
            ) : undefined
          }
        >
          <AlertTitle>
            {t("padmakara.import.aiUnavailableTitle") ||
              "AI analysis unavailable for some or all tracks"}
          </AlertTitle>
          {t("padmakara.import.aiUnavailableBody") ||
            "The grouping and titles below come from the automatic parser only. Typos or errors may slip through. If this is not urgent, retry in a few minutes for better results. Otherwise, please review each title carefully before saving."}
        </Alert>
      )}

      {notes.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            {t("padmakara.import.aiNotes") || "AI notes"} ({notes.length})
          </Typography>
          <List dense disablePadding>
            {notes.map((note, i) => (
              <ListItem key={i} disableGutters>
                <ListItemIcon sx={{ minWidth: 32 }}>
                  {note.severity === "warning" ? (
                    <ReportProblemOutlinedIcon fontSize="small" color="warning" />
                  ) : (
                    <InfoOutlinedIcon fontSize="small" color="info" />
                  )}
                </ListItemIcon>
                <ListItemText
                  primary={note.message}
                  secondary={note.relatedFilename}
                  primaryTypographyProps={{ variant: "body2" }}
                  secondaryTypographyProps={{
                    variant: "caption",
                    sx: { fontFamily: "monospace" },
                  }}
                />
              </ListItem>
            ))}
          </List>
        </Paper>
      )}
    </Box>
  );
}
