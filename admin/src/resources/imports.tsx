import { useState, useEffect, useCallback } from "react";
import {
  List,
  Datagrid,
  TextField,
  NumberField,
  DateField,
  FunctionField,
  useNotify,
  useRedirect,
  Title,
  Show,
  useRecordContext,
  useRefresh,
} from "react-admin";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import MuiTextField from "@mui/material/TextField";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import {
  listAvailableEvents,
  catalogEvent,
  proposeStructure,
  confirmStructure,
  executeImport,
  type AvailableEvent,
  type ImportJob,
  type ProposedStructure,
} from "../utils/importApi";
import { ImportStructureReview } from "../components/ImportStructureReview";

const STATUS_COLOR: Record<
  string,
  "default" | "info" | "warning" | "success" | "error"
> = {
  pending: "default",
  cataloged: "info",
  proposed: "warning",
  reviewed: "warning",
  importing: "info",
  completed: "success",
  failed: "error",
};

/** Small coloured chip for an import job's lifecycle status. */
export function ImportStatusChip({ status }: { status: string }) {
  return (
    <Chip
      label={status}
      size="small"
      color={STATUS_COLOR[status] ?? "default"}
    />
  );
}

/** Worklist of import jobs. */
export const ImportsList = () => (
  <List sort={{ field: "createdAt", order: "DESC" }} perPage={50}>
    <Datagrid rowClick="show" bulkActionButtons={false}>
      <NumberField source="id" />
      <TextField source="eventCode" label="Event code" />
      <FunctionField
        label="Status"
        render={(record: { status: string }) => (
          <ImportStatusChip status={record.status} />
        )}
      />
      <NumberField source="fileCount" label="Files" />
      <DateField source="createdAt" showTime />
    </Datagrid>
  </List>
);

/** "Catalog a legacy event" page — lists inventory events not yet imported. */
export const ImportsCreate = () => {
  const notify = useNotify();
  const redirect = useRedirect();
  const [events, setEvents] = useState<AvailableEvent[] | null>(null);
  const [filter, setFilter] = useState("");
  const [cataloging, setCataloging] = useState<string | null>(null);

  useEffect(() => {
    listAvailableEvents()
      .then((r) => setEvents(r.events))
      .catch((e: Error) =>
        notify(`Failed to load available events: ${e.message}`, {
          type: "error",
        }),
      );
  }, [notify]);

  const onCatalog = useCallback(
    async (eventCode: string) => {
      setCataloging(eventCode);
      try {
        const job = await catalogEvent(eventCode);
        notify(`Cataloged ${eventCode}`, { type: "success" });
        redirect("show", "imports", job.id);
      } catch (e) {
        notify(`Catalog failed: ${(e as Error).message}`, { type: "error" });
        setCataloging(null);
      }
    },
    [notify, redirect],
  );

  if (events === null) {
    return (
      <Box sx={{ p: 4, textAlign: "center" }}>
        <CircularProgress />
      </Box>
    );
  }

  const shown = events.filter((e) =>
    e.eventCode.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <Box sx={{ p: 2 }}>
      <Title title="Catalog a legacy event" />
      <Typography variant="h6" sx={{ mb: 1 }}>
        Legacy events available to import ({events.length})
      </Typography>
      <MuiTextField
        label="Filter by event code"
        value={filter}
        size="small"
        fullWidth
        onChange={(e) => setFilter(e.target.value)}
        sx={{ mb: 2 }}
      />
      {shown.map((e) => (
        <Paper
          key={e.eventCode}
          sx={{ p: 1.5, mb: 1, display: "flex", alignItems: "center", gap: 2 }}
        >
          <Box sx={{ flex: 1 }}>
            <Typography sx={{ fontWeight: 600 }}>{e.eventCode}</Typography>
            <Typography variant="caption" color="text.secondary">
              {e.fileCount} files · {e.matchStatus}
            </Typography>
          </Box>
          <Button
            variant="contained"
            size="small"
            disabled={cataloging !== null}
            onClick={() => onCatalog(e.eventCode)}
          >
            {cataloging === e.eventCode ? "Cataloging…" : "Catalog"}
          </Button>
        </Paper>
      ))}
      {shown.length === 0 && (
        <Typography color="text.secondary">No matching events.</Typography>
      )}
    </Box>
  );
};

/**
 * Per-job import workspace. React-admin's <Show> fetches the import job
 * (GET /api/admin/imports/:id) and provides it via record context; the
 * workspace renders the stage-appropriate action for the job's status.
 */
export const ImportsShow = () => (
  <Show>
    <ImportWorkspace />
  </Show>
);

function ImportWorkspace() {
  const job = useRecordContext<ImportJob>();
  const notify = useNotify();
  const refresh = useRefresh();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [structure, setStructure] = useState<ProposedStructure>({
    sessions: [],
  });

  // Re-seed the editable structure whenever the job (re)loads or its status
  // changes — e.g. after "Propose" populates proposedStructure.
  useEffect(() => {
    if (!job) return;
    setStructure(
      job.confirmedStructure ?? job.proposedStructure ?? { sessions: [] },
    );
  }, [job?.id, job?.status]);

  if (!job) return null;

  const run = async (
    label: string,
    action: () => Promise<unknown>,
    okMsg: string,
  ) => {
    setBusyAction(label);
    try {
      await action();
      notify(okMsg, { type: "success" });
      refresh();
    } catch (e) {
      notify((e as Error).message, { type: "error" });
    } finally {
      setBusyAction(null);
    }
  };

  const onConfirm = () => {
    // Drop empty sessions and renumber 1..N before confirming.
    const normalized: ProposedStructure = {
      sessions: structure.sessions
        .filter((s) => s.tracks.length > 0)
        .map((s, i) => ({ ...s, sessionNumber: i + 1 })),
    };
    if (normalized.sessions.length === 0) {
      notify("Add at least one session with tracks before confirming", {
        type: "warning",
      });
      return;
    }
    void run("confirm", () => confirmStructure(job.id, normalized), "Structure confirmed");
  };

  const isProposable = job.status === "pending" || job.status === "cataloged";
  const isReviewable =
    job.status === "proposed" || job.status === "reviewed";

  return (
    <Box sx={{ p: 2 }}>
      <Box sx={{ display: "flex", gap: 1.5, alignItems: "center", mb: 2 }}>
        <Typography variant="h6">{job.eventCode}</Typography>
        <ImportStatusChip status={job.status} />
        <Typography variant="caption" color="text.secondary">
          {job.fileCount} files
        </Typography>
      </Box>

      {job.status === "failed" && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {job.errorMessage ?? "Import failed."}
        </Alert>
      )}

      {isProposable && (
        <Button
          variant="contained"
          disabled={busyAction !== null}
          startIcon={
            busyAction === "propose" ? (
              <CircularProgress size={16} color="inherit" />
            ) : undefined
          }
          onClick={() =>
            void run(
              "propose",
              () => proposeStructure(job.id),
              "AI proposed a session structure",
            )
          }
        >
          Propose structure with AI
        </Button>
      )}

      {isReviewable && (
        <>
          <ImportStructureReview value={structure} onChange={setStructure} />
          <Box sx={{ display: "flex", gap: 1, mt: 2 }}>
            <Button
              variant="contained"
              disabled={busyAction !== null}
              startIcon={
                busyAction === "confirm" ? (
                  <CircularProgress size={16} color="inherit" />
                ) : undefined
              }
              onClick={onConfirm}
            >
              Confirm structure
            </Button>
            {job.status === "reviewed" && (
              <Button
                variant="contained"
                color="secondary"
                disabled={busyAction !== null}
                startIcon={
                  busyAction === "execute" ? (
                    <CircularProgress size={16} color="inherit" />
                  ) : undefined
                }
                onClick={() =>
                  void run("execute", () => executeImport(job.id), "Import executed")
                }
              >
                Run import
              </Button>
            )}
          </Box>
        </>
      )}

      {job.status === "importing" && (
        <Typography>Importing — this may take a moment…</Typography>
      )}

      {job.status === "completed" && (
        <Alert severity="success">
          Imported successfully
          {job.retreatId != null
            ? ` as event #${job.retreatId} (open it from the Events list).`
            : "."}
        </Alert>
      )}
    </Box>
  );
}
