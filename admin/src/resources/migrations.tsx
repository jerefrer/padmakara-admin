import { useState, useEffect, useCallback } from "react";
import {
  List,
  Datagrid,
  TextField,
  NumberField,
  DateField,
  FunctionField,
  DeleteButton,
  useNotify,
  useRedirect,
  Title,
  Show,
  useRecordContext,
  useRefresh,
  useDataProvider,
} from "react-admin";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import MuiTextField from "@mui/material/TextField";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import {
  listAvailableEvents,
  catalogEvent,
  proposeStructure,
  confirmStructure,
  executeImport,
  refineStructure,
  type AvailableEvent,
  type ImportJob,
  type ProposedStructure,
  type ProposedEvent,
} from "../utils/migrationApi";
import { ImportStructureReview } from "../components/ImportStructureReview";
import { ImportTranscriptsPanel } from "../components/ImportTranscriptsPanel";
import {
  EventFormFields,
  useLookups,
  EMPTY_FORM,
  type EventFormData,
  type TeacherOption,
  type PlaceOption,
  type GroupOption,
  type EventTypeOption,
  type AudienceOption,
} from "./events";

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
export const MigrationList = () => (
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
      <DeleteButton />
    </Datagrid>
  </List>
);

/** "Catalog a legacy event" page — lists inventory events not yet imported. */
export const MigrationCreate = () => {
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

  // One click catalogs the event's source files AND runs the AI analysis,
  // then opens the review screen. If the AI step fails, the job still exists
  // (cataloged) — we open it anyway so the admin can retry from there.
  const onCatalog = useCallback(
    async (eventCode: string) => {
      setCataloging(eventCode);
      let jobId: number | null = null;
      try {
        const job = await catalogEvent(eventCode);
        jobId = job.id;
        await proposeStructure(job.id);
        notify(`${eventCode} analyzed — ready for review`, { type: "success" });
        redirect("show", "migrations", job.id);
      } catch (e) {
        notify((e as Error).message, { type: "error" });
        if (jobId !== null) {
          redirect("show", "migrations", jobId);
        } else {
          setCataloging(null);
        }
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
      <Title title="Review a legacy event" />
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
            startIcon={
              cataloging === e.eventCode ? (
                <CircularProgress size={14} color="inherit" />
              ) : undefined
            }
            onClick={() => onCatalog(e.eventCode)}
          >
            {cataloging === e.eventCode ? "Analyzing…" : "Review"}
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
 * (GET /api/admin/migrations/:id) and provides it via record context; the
 * workspace renders the stage-appropriate action for the job's status.
 */
export const MigrationShow = () => (
  <Show>
    <ImportWorkspace />
  </Show>
);

function ImportWorkspace() {
  const job = useRecordContext<ImportJob>();
  const notify = useNotify();
  const refresh = useRefresh();
  const dataProvider = useDataProvider();
  const { allTeachers, allPlaces, allGroups, allEventTypes, allAudiences } =
    useLookups(dataProvider);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [structure, setStructure] = useState<ProposedStructure>({
    sessions: [],
  });
  const [instruction, setInstruction] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Event-form state — bound to the shared <EventFormFields> component.
  const [form, setForm] = useState<EventFormData>({ ...EMPTY_FORM });
  const [selectedTeachers, setSelectedTeachers] = useState<TeacherOption[]>([]);
  const [selectedPlaces, setSelectedPlaces] = useState<PlaceOption[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<GroupOption[]>([]);
  const [selectedEventType, setSelectedEventType] =
    useState<EventTypeOption | null>(null);
  const [selectedAudience, setSelectedAudience] =
    useState<AudienceOption | null>(null);

  // Re-seed the editable structure + event form whenever the job (re)loads or
  // its status changes — e.g. after "Propose" populates proposedStructure —
  // and once the lookup lists arrive (so the selected-entity chips resolve).
  useEffect(() => {
    if (!job) return;
    const struct = job.confirmedStructure ?? job.proposedStructure ?? null;
    setStructure(struct ?? { sessions: [] });
    const ev = struct?.event;
    if (ev) {
      setForm({
        eventCode: job.eventCode,
        titleEn: ev.titleEn,
        titlePt: ev.titlePt,
        mainThemesEn: ev.mainThemesEn,
        mainThemesPt: ev.mainThemesPt,
        sessionThemesEn: ev.sessionThemesEn,
        sessionThemesPt: ev.sessionThemesPt,
        startDate: ev.startDate ?? "",
        endDate: ev.endDate ?? "",
        status: ev.status,
        featuredAt: ev.featuredAt,
      });
      setSelectedTeachers(
        allTeachers.filter((t) => ev.teacherIds.includes(t.id)),
      );
      setSelectedPlaces(allPlaces.filter((p) => ev.placeIds.includes(p.id)));
      setSelectedGroups(allGroups.filter((g) => ev.groupIds.includes(g.id)));
      setSelectedEventType(
        allEventTypes.find((t) => t.id === ev.eventTypeId) ?? null,
      );
      setSelectedAudience(
        allAudiences.find((a) => a.id === ev.audienceId) ?? null,
      );
    }
  }, [
    job?.id,
    job?.status,
    allTeachers,
    allPlaces,
    allGroups,
    allEventTypes,
    allAudiences,
  ]);

  if (!job) return null;

  /** Assemble the current event-form state into a ProposedEvent. */
  const buildEvent = (): ProposedEvent => ({
    titleEn: form.titleEn,
    titlePt: form.titlePt,
    mainThemesEn: form.mainThemesEn,
    mainThemesPt: form.mainThemesPt,
    sessionThemesEn: form.sessionThemesEn,
    sessionThemesPt: form.sessionThemesPt,
    startDate: form.startDate || null,
    endDate: form.endDate || null,
    status: form.status,
    featuredAt: form.featuredAt,
    eventTypeId: selectedEventType?.id ?? null,
    audienceId: selectedAudience?.id ?? null,
    teacherIds: selectedTeachers.map((t) => t.id),
    placeIds: selectedPlaces.map((p) => p.id),
    groupIds: selectedGroups.map((g) => g.id),
  });

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

  const onRefine = async () => {
    const text = instruction.trim();
    if (text === "") return;
    setBusyAction("refine");
    try {
      const updated = await refineStructure(
        job.id,
        {
          ...structure,
          event: buildEvent(),
          transcripts: structure.transcripts ?? [],
        },
        text,
      );
      if (updated.proposedStructure) {
        setStructure(updated.proposedStructure);
      }
      setInstruction("");
      notify("The AI adjusted the structure", { type: "success" });
      refresh();
    } catch (e) {
      notify((e as Error).message, { type: "error" });
    } finally {
      setBusyAction(null);
    }
  };

  // Build the structure to persist: event metadata from the form, empty
  // sessions dropped and renumbered 1..N, ignored tracks + transcripts carried
  // through. Returns null (after warning) when there is nothing to import.
  const buildNormalizedStructure = (): ProposedStructure | null => {
    const normalized: ProposedStructure = {
      event: buildEvent(),
      sessions: structure.sessions
        .filter((s) => s.tracks.length > 0)
        .map((s, i) => ({ ...s, sessionNumber: i + 1 })),
      ignored: structure.ignored ?? [],
      transcripts: structure.transcripts ?? [],
    };
    if (normalized.sessions.length === 0) {
      notify("Add at least one session with tracks before importing", {
        type: "warning",
      });
      return null;
    }
    return normalized;
  };

  // "Save for later" — persist the reviewed structure without importing.
  const onConfirm = () => {
    const normalized = buildNormalizedStructure();
    if (!normalized) return;
    void run(
      "save",
      () => confirmStructure(job.id, normalized),
      "Saved — you can finish the import later",
    );
  };

  // "Start the import" (after the confirmation dialog) — persist the structure
  // and then run the real import in one go.
  const onRunImport = async () => {
    setConfirmOpen(false);
    const normalized = buildNormalizedStructure();
    if (!normalized) return;
    setBusyAction("import");
    try {
      await confirmStructure(job.id, normalized);
      await executeImport(job.id);
      notify("Import complete", { type: "success" });
      refresh();
    } catch (e) {
      notify((e as Error).message, { type: "error" });
    } finally {
      setBusyAction(null);
    }
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
          <EventFormFields
            form={form}
            setForm={setForm}
            selectedTeachers={selectedTeachers}
            setSelectedTeachers={setSelectedTeachers}
            selectedPlaces={selectedPlaces}
            setSelectedPlaces={setSelectedPlaces}
            selectedGroups={selectedGroups}
            setSelectedGroups={setSelectedGroups}
            selectedEventType={selectedEventType}
            setSelectedEventType={setSelectedEventType}
            selectedAudience={selectedAudience}
            setSelectedAudience={setSelectedAudience}
            allTeachers={allTeachers}
            allPlaces={allPlaces}
            allGroups={allGroups}
            allEventTypes={allEventTypes}
            allAudiences={allAudiences}
            sessions={[]}
            transcripts={[]}
            eventFiles={[]}
            onSessionTitleChange={() => {}}
            trackCount={0}
            transcriptCount={0}
            readOnlyEventCode
          />
          <ImportStructureReview
            value={structure}
            onChange={setStructure}
            teachers={allTeachers}
          />
          <ImportTranscriptsPanel
            value={structure.transcripts ?? []}
            onChange={(transcripts) =>
              setStructure({ ...structure, transcripts })
            }
          />
          <Box sx={{ mt: 2, p: 1.5, bgcolor: "action.hover", borderRadius: 1 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Ask the AI to adjust the structure
            </Typography>
            <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
              <MuiTextField
                size="small"
                fullWidth
                multiline
                placeholder="e.g. Split day 2 into a morning and an afternoon session"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                disabled={busyAction !== null}
              />
              <Button
                variant="outlined"
                disabled={busyAction !== null || instruction.trim() === ""}
                startIcon={
                  busyAction === "refine" ? (
                    <CircularProgress size={16} color="inherit" />
                  ) : undefined
                }
                onClick={() => void onRefine()}
              >
                Adjust
              </Button>
            </Box>
          </Box>
          <Box sx={{ display: "flex", gap: 1, mt: 2 }}>
            <Button
              variant="outlined"
              disabled={busyAction !== null}
              startIcon={
                busyAction === "save" ? (
                  <CircularProgress size={16} color="inherit" />
                ) : undefined
              }
              onClick={onConfirm}
            >
              Save for later
            </Button>
            <Button
              variant="contained"
              color="warning"
              disabled={busyAction !== null}
              startIcon={
                busyAction === "import" ? (
                  <CircularProgress size={16} color="inherit" />
                ) : undefined
              }
              onClick={() => {
                if (buildNormalizedStructure() !== null) setConfirmOpen(true);
              }}
            >
              Start the import
            </Button>
          </Box>

          <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
            <DialogTitle>Start the import for {job.eventCode}?</DialogTitle>
            <DialogContent>
              <DialogContentText>
                This copies every audio file and transcript from the legacy
                bucket and creates the event with its sessions and tracks. It
                can take a few minutes for a large event. Make sure the
                structure and the event details are correct — once imported,
                this event code cannot be imported again.
              </DialogContentText>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
              <Button
                variant="contained"
                color="warning"
                onClick={() => void onRunImport()}
              >
                Start the import
              </Button>
            </DialogActions>
          </Dialog>
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
