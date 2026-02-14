/**
 * Migration Management UI
 *
 * Complete workflow for Wix → Database migrations:
 * 1. Upload CSV
 * 2. Analyze & catalog all S3 files
 * 3. Make granular per-file decisions
 * 4. Review & approve
 * 5. Execute & monitor progress
 */

import { useState, useCallback, useEffect } from "react";
import {
  List,
  Datagrid,
  TextField,
  DateField,
  FunctionField,
  useDataProvider,
  useNotify,
  useRedirect,
  Title,
  useGetOne,
  useTranslate,
  ShowButton,
  useRefresh,
} from "react-admin";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import WarningIcon from "@mui/icons-material/Warning";
import { useParams } from "react-router-dom";
import { useDropzone } from "react-dropzone";

/* ───────────── Types ───────────── */

type MigrationStatus =
  | "uploaded"
  | "analyzing"
  | "analyzed"
  | "decisions_pending"
  | "decisions_complete"
  | "approved"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

type FileAction = "include" | "ignore" | "rename" | "review";
type FileCategory = "audio_main" | "audio_translation" | "audio_legacy" | "video" | "transcript" | "document" | "image" | "archive" | "other";

interface CatalogedFile {
  id: number;
  filename: string;
  s3Key: string;
  s3Directory: string;
  fileType: string;
  category: FileCategory;
  extension: string;
  fileSize: number | null;
  mimeType: string;
  suggestedAction: FileAction;
  suggestedCategory: FileCategory | null;
  conflicts: string[];
  metadata: Record<string, any>;
}

interface EventCatalog {
  eventCode: string;
  s3Directory: string;
  files: CatalogedFile[];
}

interface Migration {
  id: number;
  title: string;
  status: MigrationStatus;
  csvRowCount: number | null;
  progressPercentage: number;
  processedEvents: number;
  successfulEvents: number;
  failedEvents: number;
  analyzedAt: string | null;
  createdAt: string;
  updatedAt: string;
  analysisData?: {
    totalEvents: number;
    validEvents: number;
    eventsWithAudio: number;
    eventsWithVideo: number;
    eventsWithoutMedia: number;
    totalAudioFiles: number;
    totalVideoFiles: number;
    totalDocuments: number;
    totalArchives: number;
    eventsWithZips: number;
    eventsWithLooseFiles: number;
    csvTrackMatches: number;
    csvTracksMissing: number;
    issues: Array<{
      severity: "error" | "warning" | "info";
      category: string;
      message: string;
      eventCode: string;
    }>;
  };
}

/* ───────────── Status Chips ───────────── */

const StatusChip = ({ status }: { status: MigrationStatus }) => {
  const colorMap: Record<MigrationStatus, "success" | "warning" | "error" | "info" | "default"> = {
    uploaded: "default",
    analyzing: "info",
    analyzed: "info",
    decisions_pending: "warning",
    decisions_complete: "warning",
    approved: "success",
    executing: "info",
    completed: "success",
    failed: "error",
    cancelled: "default",
  };

  const labelMap: Record<MigrationStatus, string> = {
    uploaded: "Uploaded",
    analyzing: "Analyzing...",
    analyzed: "Analyzed",
    decisions_pending: "Decisions Pending",
    decisions_complete: "Ready",
    approved: "Approved",
    executing: "Executing...",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  };

  return (
    <Chip
      label={labelMap[status]}
      size="small"
      color={colorMap[status]}
      sx={{ fontWeight: 600 }}
    />
  );
};

/* ───────────── Migration List ───────────── */

export const MigrationList = () => {
  const translate = useTranslate();
  const redirect = useRedirect();

  return (
    <Box sx={{ maxWidth: 1200, mx: "auto" }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          Migrations
        </Typography>
        <Button
          variant="contained"
          startIcon={<UploadFileIcon />}
          onClick={() => redirect("/migrations/create")}
        >
          New Migration
        </Button>
      </Box>

      <List
        sort={{ field: "createdAt", order: "DESC" }}
        perPage={25}
        sx={{ "& .RaList-main": { boxShadow: "none" } }}
      >
        <Datagrid
          rowClick="show"
          bulkActionButtons={false}
          sx={{ "& .RaDatagrid-row": { "&:hover": { backgroundColor: "rgba(91,94,166,0.03)" } } }}
        >
          <TextField source="id" label="ID" sx={{ fontFamily: "monospace" }} />
          <TextField source="title" label="Title" />
          <FunctionField
            label="Status"
            render={(record: Migration) => <StatusChip status={record.status} />}
          />
          <FunctionField
            label="Progress"
            render={(record: Migration) => {
              if (record.status === "executing" || record.status === "completed") {
                return (
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 120 }}>
                    <LinearProgress
                      variant="determinate"
                      value={record.progressPercentage}
                      sx={{ flex: 1, height: 6, borderRadius: 3 }}
                    />
                    <Typography variant="caption" sx={{ fontWeight: 600, minWidth: 35 }}>
                      {record.progressPercentage}%
                    </Typography>
                  </Box>
                );
              }
              return "—";
            }}
          />
          <FunctionField
            label="Events"
            render={(record: Migration) => {
              if (record.analysisData) {
                return `${record.analysisData.totalEvents} events`;
              }
              if (record.csvRowCount) {
                return `${record.csvRowCount} rows`;
              }
              return "—";
            }}
          />
          <DateField source="createdAt" label="Created" showTime />
          <ShowButton />
        </Datagrid>
      </List>
    </Box>
  );
};

/* ───────────── Migration Create (CSV Upload) ───────────── */

export const MigrationCreate = () => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const redirect = useRedirect();
  const translate = useTranslate();

  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles[0]) {
      setCsvFile(acceptedFiles[0]);
      if (!title) {
        setTitle(acceptedFiles[0].name.replace(/\.csv$/i, ""));
      }
    }
  }, [title]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "text/csv": [".csv"] },
    multiple: false,
  });

  const handleUpload = async () => {
    if (!csvFile || !title) {
      notify("Please provide a title and CSV file", { type: "warning" });
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("csv", csvFile);
      formData.append("title", title);
      if (notes) formData.append("notes", notes);

      const response = await fetch("/api/admin/migrations/upload", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("accessToken")}`,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error("Upload failed");
      }

      const result = await response.json();
      notify("padmakara.migrations.createdSuccess", { type: "success", messageArgs: { _: "Migration created successfully" } });
      redirect("show", "migrations", result.migration.id);
    } catch (error: any) {
      notify(`Error: ${error.message}`, { type: "error" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 800, mx: "auto", pb: 6 }}>
      <Title title="New Migration" />
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 4 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => redirect("list", "migrations")}
          sx={{ color: "text.secondary" }}
        >
          Back
        </Button>
        <Box sx={{ flex: 1 }} />
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          New Migration
        </Typography>
      </Box>

      <Paper sx={{ p: 4 }}>
        {/* Title & Notes */}
        <Box sx={{ mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>
            Migration Title
          </Typography>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="2025 Spring Migration"
            style={{
              width: "100%",
              padding: "12px",
              fontSize: "16px",
              border: "1px solid #ddd",
              borderRadius: "4px",
            }}
          />
        </Box>

        <Box sx={{ mb: 3 }}>
          <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>
            Notes (optional)
          </Typography>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add any notes about this migration..."
            rows={3}
            style={{
              width: "100%",
              padding: "12px",
              fontSize: "16px",
              border: "1px solid #ddd",
              borderRadius: "4px",
              fontFamily: "inherit",
            }}
          />
        </Box>

        {/* CSV Upload */}
        <Box
          {...getRootProps()}
          sx={{
            border: "2px dashed",
            borderColor: isDragActive ? "primary.main" : "#ddd",
            borderRadius: 2,
            p: 4,
            textAlign: "center",
            cursor: "pointer",
            backgroundColor: isDragActive ? "rgba(91,94,166,0.05)" : "transparent",
            transition: "all 0.2s",
            "&:hover": {
              borderColor: "primary.main",
              backgroundColor: "rgba(91,94,166,0.03)",
            },
          }}
        >
          <input {...getInputProps()} />
          <CloudUploadIcon sx={{ fontSize: 48, color: "text.secondary", mb: 2 }} />
          <Typography variant="h6" sx={{ mb: 1 }}>
            {csvFile ? csvFile.name : "Drop CSV file here"}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {csvFile
              ? `${(csvFile.size / 1024).toFixed(1)} KB`
              : "or click to select file"}
          </Typography>
        </Box>

        {/* Upload Button */}
        <Box sx={{ mt: 3, display: "flex", justifyContent: "flex-end", gap: 2 }}>
          <Button
            variant="outlined"
            onClick={() => redirect("list", "migrations")}
            disabled={uploading}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            size="large"
            startIcon={<UploadFileIcon />}
            onClick={handleUpload}
            disabled={!csvFile || !title || uploading}
            sx={{ px: 4 }}
          >
            {uploading ? "Uploading..." : "Upload & Continue"}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
};

/* ───────────── Migration Show (Multi-Tab View) ───────────── */

export const MigrationShow = () => {
  const { id } = useParams<{ id: string }>();
  const redirect = useRedirect();
  const notify = useNotify();
  const refresh = useRefresh();

  const { data: migration, isPending } = useGetOne<Migration>("migrations", { id: Number(id!) });
  const [currentTab, setCurrentTab] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);

  // Start analysis
  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const response = await fetch(`/api/admin/migrations/${id}/analyze`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("accessToken")}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) throw new Error("Analysis failed");

      notify("Analysis complete!", { type: "success" });
      refresh();
      setCurrentTab(1); // Move to decisions tab
    } catch (error: any) {
      notify(`Error: ${error.message}`, { type: "error" });
    } finally {
      setAnalyzing(false);
    }
  };

  if (isPending) {
    return (
      <Box sx={{ maxWidth: 1200, mx: "auto", pt: 4 }}>
        <LinearProgress />
      </Box>
    );
  }

  if (!migration) {
    return <div>Migration not found</div>;
  }

  return (
    <Box sx={{ maxWidth: 1200, mx: "auto", pb: 6 }}>
      <Title title={`Migration: ${migration.title}`} />

      {/* Header */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 3 }}>
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => redirect("list", "migrations")}
          sx={{ color: "text.secondary" }}
        >
          Back
        </Button>
        <Box sx={{ flex: 1 }} />
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          {migration.title}
        </Typography>
        <StatusChip status={migration.status} />
      </Box>

      {/* Tabs */}
      <Paper sx={{ mb: 2 }}>
        <Tabs
          value={currentTab}
          onChange={(_, v) => setCurrentTab(v)}
          sx={{ borderBottom: 1, borderColor: "divider" }}
        >
          <Tab label="Overview" />
          <Tab label="File Decisions" disabled={migration.status === "uploaded"} />
          <Tab label="Review" disabled={!["decisions_pending", "decisions_complete", "approved"].includes(migration.status)} />
          <Tab label="Execution" disabled={!["executing", "completed", "failed"].includes(migration.status)} />
        </Tabs>

        {/* Tab 0: Overview */}
        {currentTab === 0 && (
          <Box sx={{ p: 3 }}>
            <OverviewTab migration={migration} onAnalyze={handleAnalyze} analyzing={analyzing} />
          </Box>
        )}

        {/* Tab 1: File Decisions */}
        {currentTab === 1 && migration.status !== "uploaded" && (
          <Box sx={{ p: 3 }}>
            <FileDecisionsTab migrationId={migration.id} />
          </Box>
        )}

        {/* Tab 2: Review */}
        {currentTab === 2 && ["decisions_pending", "decisions_complete", "approved"].includes(migration.status) && (
          <Box sx={{ p: 3 }}>
            <ReviewTab migration={migration} onApproved={() => { refresh(); setCurrentTab(3); }} />
          </Box>
        )}

        {/* Tab 3: Execution */}
        {currentTab === 3 && ["executing", "completed", "failed"].includes(migration.status) && (
          <Box sx={{ p: 3 }}>
            <ExecutionTab migration={migration} />
          </Box>
        )}
      </Paper>
    </Box>
  );
};

/* ───────────── Overview Tab ───────────── */

const OverviewTab = ({
  migration,
  onAnalyze,
  analyzing,
}: {
  migration: Migration;
  onAnalyze: () => void;
  analyzing: boolean;
}) => {
  if (migration.status === "uploaded") {
    return (
      <Box sx={{ textAlign: "center", py: 4 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>
          CSV Uploaded
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          {migration.csvRowCount} rows found in CSV file
        </Typography>
        <Button
          variant="contained"
          size="large"
          onClick={onAnalyze}
          disabled={analyzing}
          sx={{ px: 4 }}
        >
          {analyzing ? "Analyzing..." : "Start Analysis"}
        </Button>
      </Box>
    );
  }

  if (!migration.analysisData) {
    return <div>No analysis data available</div>;
  }

  const { analysisData } = migration;

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 3 }}>
        Analysis Summary
      </Typography>

      {/* Statistics Grid */}
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 2, mb: 3 }}>
        <StatCard label="Total Events" value={analysisData.totalEvents} icon={<CheckCircleIcon />} />
        <StatCard label="Audio Files" value={analysisData.totalAudioFiles} />
        <StatCard label="Video Files" value={analysisData.totalVideoFiles} />
        <StatCard label="Documents" value={analysisData.totalDocuments} />
        <StatCard label="Archives (ZIPs)" value={analysisData.totalArchives} />
      </Box>

      {/* S3 Discovery Stats */}
      <Typography variant="h6" sx={{ mb: 2 }}>
        S3 Discovery
      </Typography>
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 2, mb: 3 }}>
        <StatCard label="Events with ZIPs" value={analysisData.eventsWithZips ?? 0} />
        <StatCard label="Events with Loose Files" value={analysisData.eventsWithLooseFiles ?? 0} />
        <StatCard label="CSV Tracks Matched" value={analysisData.csvTrackMatches ?? 0} />
        <StatCard label="CSV Tracks Missing" value={analysisData.csvTracksMissing ?? 0} />
        <StatCard label="Events without Media" value={analysisData.eventsWithoutMedia ?? 0} />
      </Box>

      {/* Issues */}
      {analysisData.issues && analysisData.issues.length > 0 && (
        <Box sx={{ mt: 3 }}>
          <Typography variant="h6" sx={{ mb: 2 }}>
            Issues ({analysisData.issues.length})
          </Typography>
          {analysisData.issues.slice(0, 10).map((issue, idx) => (
            <Box
              key={idx}
              sx={{
                p: 2,
                mb: 1,
                border: "1px solid #ddd",
                borderRadius: 1,
                display: "flex",
                alignItems: "flex-start",
                gap: 1,
              }}
            >
              {issue.severity === "error" && <ErrorIcon color="error" fontSize="small" />}
              {issue.severity === "warning" && <WarningIcon color="warning" fontSize="small" />}
              {issue.severity === "info" && <CheckCircleIcon color="info" fontSize="small" />}
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {issue.eventCode}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {issue.message}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};

const StatCard = ({ label, value, icon }: { label: string; value: number; icon?: React.ReactNode }) => (
  <Paper sx={{ p: 2, textAlign: "center" }} variant="outlined">
    {icon && <Box sx={{ mb: 1 }}>{icon}</Box>}
    <Typography variant="h4" sx={{ fontWeight: 700, color: "primary.main" }}>
      {value.toLocaleString()}
    </Typography>
    <Typography variant="body2" color="text.secondary">
      {label}
    </Typography>
  </Paper>
);

/* ───────────── File Decisions Tab (KEY FEATURE) ───────────── */

interface FileDecision {
  catalogId: number;
  action: FileAction;
  newFilename?: string;
  targetCategory?: FileCategory;
  notes?: string;
}

const FileDecisionsTab = ({ migrationId }: { migrationId: number }) => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();

  const [events, setEvents] = useState<EventCatalog[]>([]);
  const [decisions, setDecisions] = useState<Map<number, FileDecision>>(new Map());
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Fetch file catalogs and existing decisions
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [catalogsRes, decisionsRes] = await Promise.all([
          fetch(`/api/admin/migrations/${migrationId}`, {
            headers: { Authorization: `Bearer ${localStorage.getItem("accessToken")}` },
          }),
          fetch(`/api/admin/migrations/${migrationId}/decisions`, {
            headers: { Authorization: `Bearer ${localStorage.getItem("accessToken")}` },
          }),
        ]);

        const catalogsData = await catalogsRes.json();
        const decisionsData = await decisionsRes.json();

        // Group files by event
        const eventMap = new Map<string, CatalogedFile[]>();
        for (const file of catalogsData.totalFiles || []) {
          if (!eventMap.has(file.eventCode)) {
            eventMap.set(file.eventCode, []);
          }
          eventMap.get(file.eventCode)!.push(file);
        }

        const eventCatalogs: EventCatalog[] = Array.from(eventMap.entries()).map(([eventCode, files]) => ({
          eventCode,
          s3Directory: files[0]?.s3Directory || "",
          files,
        }));

        setEvents(eventCatalogs);

        // Load existing decisions
        const decisionsMap = new Map<number, FileDecision>();
        for (const decision of decisionsData.decisions || []) {
          decisionsMap.set(decision.catalogId, decision);
        }
        setDecisions(decisionsMap);

        // Expand first event by default
        if (eventCatalogs.length > 0) {
          setExpandedEvents(new Set([eventCatalogs[0]!.eventCode]));
        }
      } catch (error: any) {
        notify(`Error loading files: ${error.message}`, { type: "error" });
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [migrationId, notify]);

  // Save decisions to backend (debounced)
  const saveDecisions = useCallback(async () => {
    setSaving(true);
    try {
      const decisionsArray = Array.from(decisions.values());
      await fetch(`/api/admin/migrations/${migrationId}/decisions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("accessToken")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decisions: decisionsArray }),
      });
      notify("Decisions saved", { type: "success" });
      refresh();
    } catch (error: any) {
      notify(`Error saving: ${error.message}`, { type: "error" });
    } finally {
      setSaving(false);
    }
  }, [decisions, migrationId, notify, refresh]);

  const toggleEvent = (eventCode: string) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventCode)) {
        next.delete(eventCode);
      } else {
        next.add(eventCode);
      }
      return next;
    });
  };

  const updateDecision = (catalogId: number, decision: Partial<FileDecision>) => {
    setDecisions((prev) => {
      const next = new Map(prev);
      const existing = next.get(catalogId) || { catalogId, action: "review" };
      next.set(catalogId, { ...existing, ...decision });
      return next;
    });
  };

  if (loading) {
    return <LinearProgress />;
  }

  const totalFiles = events.reduce((sum, event) => sum + event.files.length, 0);
  const decidedFiles = Array.from(decisions.values()).filter((d) => d.action !== "review").length;
  const progressPercent = totalFiles > 0 ? Math.round((decidedFiles / totalFiles) * 100) : 0;

  return (
    <Box>
      {/* Progress Header */}
      <Box sx={{ mb: 3, p: 2, bgcolor: "rgba(91,94,166,0.05)", borderRadius: 1 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", mb: 1 }}>
          <Typography variant="h6">File Decisions</Typography>
          <Typography variant="body2" color="text.secondary">
            {decidedFiles} / {totalFiles} files decided ({progressPercent}%)
          </Typography>
        </Box>
        <LinearProgress variant="determinate" value={progressPercent} sx={{ height: 6, borderRadius: 3 }} />
      </Box>

      {/* Events List */}
      {events.map((event) => (
        <EventTree
          key={event.eventCode}
          event={event}
          decisions={decisions}
          expanded={expandedEvents.has(event.eventCode)}
          onToggle={() => toggleEvent(event.eventCode)}
          onDecisionChange={updateDecision}
        />
      ))}

      {/* Save Button */}
      <Box sx={{ mt: 3, display: "flex", justifyContent: "flex-end", gap: 2 }}>
        <Button
          variant="contained"
          size="large"
          onClick={saveDecisions}
          disabled={saving || decidedFiles === 0}
          sx={{ px: 4 }}
        >
          {saving ? "Saving..." : "Save Decisions"}
        </Button>
      </Box>
    </Box>
  );
};

/* ───────────── EventTree Component ───────────── */

interface EventTreeProps {
  event: EventCatalog;
  decisions: Map<number, FileDecision>;
  expanded: boolean;
  onToggle: () => void;
  onDecisionChange: (catalogId: number, decision: Partial<FileDecision>) => void;
}

const EventTree = ({ event, decisions, expanded, onToggle, onDecisionChange }: EventTreeProps) => {
  // Group files by type
  const audioFiles = event.files.filter((f) => f.fileType === "audio");
  const videoFiles = event.files.filter((f) => f.fileType === "video");
  const documentFiles = event.files.filter((f) => f.fileType === "document");
  const archiveFiles = event.files.filter((f) => f.fileType === "archive");
  const otherFiles = event.files.filter((f) => !["audio", "video", "document", "archive"].includes(f.fileType));

  const decidedCount = event.files.filter((f) => {
    const decision = decisions.get(f.id);
    return decision && decision.action !== "review";
  }).length;

  return (
    <Paper sx={{ mb: 2, overflow: "hidden" }} variant="outlined">
      {/* Event Header */}
      <Box
        onClick={onToggle}
        sx={{
          p: 2,
          display: "flex",
          alignItems: "center",
          gap: 1,
          cursor: "pointer",
          bgcolor: "rgba(91,94,166,0.03)",
          "&:hover": { bgcolor: "rgba(91,94,166,0.08)" },
        }}
      >
        <Typography sx={{ fontFamily: "monospace", fontWeight: 600 }}>
          {expanded ? "▼" : "►"}
        </Typography>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>
          {event.eventCode}
        </Typography>
        <Chip
          label={`${decidedCount} / ${event.files.length} decided`}
          size="small"
          color={decidedCount === event.files.length ? "success" : "default"}
        />
      </Box>

      {/* File Groups */}
      {expanded && (
        <Box sx={{ p: 2 }}>
          {audioFiles.length > 0 && (
            <FileTypeGroup
              label="Audio Files"
              files={audioFiles}
              decisions={decisions}
              onDecisionChange={onDecisionChange}
            />
          )}
          {videoFiles.length > 0 && (
            <FileTypeGroup
              label="Video Files"
              files={videoFiles}
              decisions={decisions}
              onDecisionChange={onDecisionChange}
            />
          )}
          {documentFiles.length > 0 && (
            <FileTypeGroup
              label="Documents"
              files={documentFiles}
              decisions={decisions}
              onDecisionChange={onDecisionChange}
            />
          )}
          {archiveFiles.length > 0 && (
            <FileTypeGroup
              label="Archives"
              files={archiveFiles}
              decisions={decisions}
              onDecisionChange={onDecisionChange}
            />
          )}
          {otherFiles.length > 0 && (
            <FileTypeGroup
              label="Other Files"
              files={otherFiles}
              decisions={decisions}
              onDecisionChange={onDecisionChange}
            />
          )}
        </Box>
      )}
    </Paper>
  );
};

/* ───────────── FileTypeGroup Component ───────────── */

interface FileTypeGroupProps {
  label: string;
  files: CatalogedFile[];
  decisions: Map<number, FileDecision>;
  onDecisionChange: (catalogId: number, decision: Partial<FileDecision>) => void;
}

const FileTypeGroup = ({ label, files, decisions, onDecisionChange }: FileTypeGroupProps) => {
  const [expanded, setExpanded] = useState(true);

  return (
    <Box sx={{ mb: 2 }}>
      {/* Group Header */}
      <Box
        onClick={() => setExpanded(!expanded)}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          cursor: "pointer",
          p: 1,
          borderRadius: 1,
          "&:hover": { bgcolor: "rgba(0,0,0,0.03)" },
        }}
      >
        <Typography sx={{ fontWeight: 600, fontSize: "0.9rem" }}>
          {expanded ? "▼" : "►"} {label} ({files.length})
        </Typography>
      </Box>

      {/* Files */}
      {expanded && (
        <Box sx={{ pl: 3 }}>
          {files.map((file) => (
            <FileRow
              key={file.id}
              file={file}
              decision={decisions.get(file.id)}
              onChange={(decision) => onDecisionChange(file.id, decision)}
            />
          ))}
        </Box>
      )}
    </Box>
  );
};

/* ───────────── FileRow Component ───────────── */

interface FileRowProps {
  file: CatalogedFile;
  decision: FileDecision | undefined;
  onChange: (decision: Partial<FileDecision>) => void;
}

const FileRow = ({ file, decision, onChange }: FileRowProps) => {
  const action = decision?.action || file.suggestedAction;
  const category = decision?.targetCategory || file.category;
  const newFilename = decision?.newFilename || "";

  const hasConflicts = file.conflicts && file.conflicts.length > 0;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        p: 1.5,
        mb: 1,
        border: "1px solid",
        borderColor: hasConflicts ? "warning.light" : "#e0e0e0",
        borderRadius: 1,
        bgcolor: hasConflicts ? "rgba(255,152,0,0.05)" : "white",
      }}
    >
      {/* Checkbox */}
      <input
        type="checkbox"
        checked={action === "include" || action === "rename"}
        onChange={(e) => onChange({ action: e.target.checked ? "include" : "ignore" })}
        style={{ width: 18, height: 18 }}
      />

      {/* Filename & Target Path */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{
            fontFamily: "monospace",
            fontWeight: 500,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {file.filename}
        </Typography>
        {file.metadata?.targetS3Key && (
          <Typography
            variant="caption"
            sx={{
              fontFamily: "monospace",
              color: "success.main",
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            → {file.metadata.targetS3Key}
          </Typography>
        )}
        {hasConflicts && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.5 }}>
            <WarningIcon color="warning" sx={{ fontSize: 16 }} />
            <Typography variant="caption" color="warning.main">
              {file.conflicts[0]}
            </Typography>
          </Box>
        )}
      </Box>

      {/* Category Dropdown */}
      <select
        value={category}
        onChange={(e) => onChange({ targetCategory: e.target.value as FileCategory })}
        style={{
          padding: "6px 8px",
          fontSize: "14px",
          border: "1px solid #ddd",
          borderRadius: "4px",
          minWidth: 140,
        }}
      >
        <option value="audio_main">Main Audio</option>
        <option value="audio_translation">Translation</option>
        <option value="audio_legacy">Legacy Audio</option>
        <option value="video">Video</option>
        <option value="transcript">Transcript</option>
        <option value="document">Document</option>
        <option value="image">Image</option>
        <option value="archive">Archive</option>
        <option value="other">Other</option>
      </select>

      {/* Action Buttons */}
      <Box sx={{ display: "flex", gap: 1 }}>
        <Button
          size="small"
          variant={action === "include" ? "contained" : "outlined"}
          onClick={() => onChange({ action: "include" })}
          sx={{ minWidth: 80 }}
        >
          Include
        </Button>
        <Button
          size="small"
          variant={action === "ignore" ? "contained" : "outlined"}
          color="error"
          onClick={() => onChange({ action: "ignore" })}
          sx={{ minWidth: 80 }}
        >
          Ignore
        </Button>
        <Button
          size="small"
          variant={action === "rename" ? "contained" : "outlined"}
          onClick={() => onChange({ action: action === "rename" ? "include" : "rename" })}
          sx={{ minWidth: 80 }}
        >
          Rename
        </Button>
      </Box>

      {/* Rename Input (conditional) */}
      {action === "rename" && (
        <input
          type="text"
          value={newFilename}
          onChange={(e) => onChange({ newFilename: e.target.value })}
          placeholder="New filename..."
          style={{
            padding: "6px 8px",
            fontSize: "14px",
            border: "1px solid #ddd",
            borderRadius: "4px",
            minWidth: 200,
          }}
        />
      )}
    </Box>
  );
};

/* ───────────── Review Tab ───────────── */

const ReviewTab = ({ migration, onApproved }: { migration: Migration; onApproved: () => void }) => {
  const notify = useNotify();
  const refresh = useRefresh();
  const [approving, setApproving] = useState(false);
  const [executing, setExecuting] = useState(false);

  const handleApprove = async () => {
    setApproving(true);
    try {
      const response = await fetch(`/api/admin/migrations/${migration.id}/approve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("accessToken")}`,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Approval failed");
      }
      notify("Migration approved!", { type: "success" });
      refresh();
    } catch (error: any) {
      notify(`Error: ${error.message}`, { type: "error" });
    } finally {
      setApproving(false);
    }
  };

  const handleExecute = async () => {
    setExecuting(true);
    try {
      const response = await fetch(`/api/admin/migrations/${migration.id}/execute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("accessToken")}`,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Execution failed");
      }
      notify("Migration execution started!", { type: "success" });
      onApproved();
    } catch (error: any) {
      notify(`Error: ${error.message}`, { type: "error" });
    } finally {
      setExecuting(false);
    }
  };

  const { analysisData } = migration;

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 3 }}>
        Review & Approval
      </Typography>

      {/* Summary */}
      {analysisData && (
        <Paper sx={{ p: 3, mb: 3 }} variant="outlined">
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
            Migration Summary
          </Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
            <Typography variant="body2">Total events: <strong>{analysisData.totalEvents}</strong></Typography>
            <Typography variant="body2">Audio files: <strong>{analysisData.totalAudioFiles}</strong></Typography>
            <Typography variant="body2">Events with ZIPs: <strong>{analysisData.eventsWithZips ?? 0}</strong></Typography>
            <Typography variant="body2">Loose file events: <strong>{analysisData.eventsWithLooseFiles ?? 0}</strong></Typography>
            <Typography variant="body2">CSV tracks matched: <strong>{analysisData.csvTrackMatches ?? 0}</strong></Typography>
            <Typography variant="body2" color={analysisData.csvTracksMissing ? "error" : "text.secondary"}>
              CSV tracks missing: <strong>{analysisData.csvTracksMissing ?? 0}</strong>
            </Typography>
            <Typography variant="body2">Documents: <strong>{analysisData.totalDocuments}</strong></Typography>
            <Typography variant="body2">Archives: <strong>{analysisData.totalArchives}</strong></Typography>
          </Box>

          {/* Issues summary */}
          {analysisData.issues && analysisData.issues.length > 0 && (
            <Box sx={{ mt: 2, p: 2, bgcolor: "rgba(255,152,0,0.08)", borderRadius: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
                <WarningIcon sx={{ fontSize: 16, verticalAlign: "text-bottom", mr: 0.5 }} color="warning" />
                {analysisData.issues.length} issues found
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {analysisData.issues.filter(i => i.severity === "error").length} errors,{" "}
                {analysisData.issues.filter(i => i.severity === "warning").length} warnings
              </Typography>
            </Box>
          )}
        </Paper>
      )}

      {/* Action Buttons */}
      <Box sx={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
        {migration.status !== "approved" && (
          <Button
            variant="contained"
            color="success"
            size="large"
            onClick={handleApprove}
            disabled={approving}
            sx={{ px: 4 }}
          >
            {approving ? "Approving..." : "Approve Migration"}
          </Button>
        )}
        {migration.status === "approved" && (
          <Button
            variant="contained"
            color="primary"
            size="large"
            onClick={handleExecute}
            disabled={executing}
            startIcon={<CheckCircleIcon />}
            sx={{ px: 4 }}
          >
            {executing ? "Starting..." : "Execute Migration"}
          </Button>
        )}
      </Box>
    </Box>
  );
};

/* ───────────── Execution Tab ───────────── */

const ExecutionTab = ({ migration }: { migration: Migration }) => {
  const refresh = useRefresh();
  const totalEvents = migration.analysisData?.totalEvents || 0;

  // Auto-refresh while executing
  useEffect(() => {
    if (migration.status !== "executing") return;
    const interval = setInterval(() => refresh(), 3000);
    return () => clearInterval(interval);
  }, [migration.status, refresh]);

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 3 }}>
        <Typography variant="h6">
          Execution Progress
        </Typography>
        <StatusChip status={migration.status} />
      </Box>

      <LinearProgress
        variant="determinate"
        value={migration.progressPercentage}
        color={migration.status === "failed" ? "error" : migration.status === "completed" ? "success" : "primary"}
        sx={{ mb: 2, height: 10, borderRadius: 5 }}
      />

      <Typography variant="h5" sx={{ fontWeight: 700, mb: 3 }}>
        {migration.progressPercentage}% Complete
      </Typography>

      {/* Event Counters */}
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 2 }}>
        <Paper sx={{ p: 2, textAlign: "center" }} variant="outlined">
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            {migration.processedEvents || 0}
          </Typography>
          <Typography variant="body2" color="text.secondary">Processed</Typography>
        </Paper>
        <Paper sx={{ p: 2, textAlign: "center" }} variant="outlined">
          <Typography variant="h4" sx={{ fontWeight: 700, color: "success.main" }}>
            {migration.successfulEvents || 0}
          </Typography>
          <Typography variant="body2" color="text.secondary">Successful</Typography>
        </Paper>
        <Paper sx={{ p: 2, textAlign: "center" }} variant="outlined">
          <Typography variant="h4" sx={{ fontWeight: 700, color: "error.main" }}>
            {migration.failedEvents || 0}
          </Typography>
          <Typography variant="body2" color="text.secondary">Failed</Typography>
        </Paper>
        <Paper sx={{ p: 2, textAlign: "center" }} variant="outlined">
          <Typography variant="h4" sx={{ fontWeight: 700, color: "text.secondary" }}>
            {totalEvents - (migration.processedEvents || 0)}
          </Typography>
          <Typography variant="body2" color="text.secondary">Remaining</Typography>
        </Paper>
      </Box>
    </Box>
  );
};
