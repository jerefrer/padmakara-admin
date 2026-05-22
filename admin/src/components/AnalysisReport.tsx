import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
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
  /** When set, renders an "Export for review" button in the header. */
  onExport?: () => void;
}

/**
 * Top-of-page panel for an AI analysis. Always renders a header (title +
 * coverage chip + optional export button), then a warning banner if analysis
 * degraded, then the AI notes list if any.
 */
export function AnalysisReport({ notes, aiCoverage, onRetryAi, onExport }: AnalysisReportProps) {
  const t = useTranslate();

  const aiDegraded =
    aiCoverage.tracksAnalyzedByAi === 0 || aiCoverage.chunksFailed > 0;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, mb: 1 }}>
      {/* Header: title + coverage + export */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
        <AutoAwesomeIcon color="primary" />
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          {t("padmakara.import.analysisReportTitle") || "AI analysis"}
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          label={`${aiCoverage.totalTracks} ${t("padmakara.import.tracksLabel") || "tracks"}`}
        />
        <Box sx={{ flexGrow: 1 }} />
        {onExport && (
          <Button
            variant="outlined"
            size="small"
            startIcon={<FileDownloadOutlinedIcon />}
            onClick={onExport}
            sx={{ textTransform: "none", borderRadius: 2 }}
          >
            {t("padmakara.import.exportReview") || "Export for review (Excel)"}
          </Button>
        )}
      </Box>

      {aiDegraded && (
        <Alert
          severity="warning"
          icon={<AutoAwesomeIcon />}
          action={
            onRetryAi ? (
              <Button
                variant="contained"
                color="warning"
                size="small"
                onClick={onRetryAi}
                startIcon={<AutoAwesomeIcon />}
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
