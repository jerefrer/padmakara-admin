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
} from "react-admin";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import MuiTextField from "@mui/material/TextField";
import CircularProgress from "@mui/material/CircularProgress";
import {
  listAvailableEvents,
  catalogEvent,
  type AvailableEvent,
} from "../utils/importApi.ts";

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
