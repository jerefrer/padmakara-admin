import { useEffect, useState } from "react";
import {
  List,
  Edit,
  Create,
  SimpleForm,
  TextInput,
  required,
  useTranslate,
  SaveButton,
  Toolbar,
  useNotify,
  useRedirect,
  useRecordContext,
  useDataProvider,
} from "react-admin";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  TextField as MuiTextField,
  Typography,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import { SortableList } from "../components/SortableList";
import { GroupImageUpload } from "../components/GroupImageUpload";
import { authFetch } from "../utils/authFetch";

const API_URL = "/api/admin";

interface GroupRecord {
  id: number;
  nameEn: string;
  namePt?: string | null;
}

interface LinkedEvent {
  id: number;
  eventCode: string;
  titleEn: string;
  titlePt: string | null;
  startDate: string | null;
}

export const GroupList = () => {
  const translate = useTranslate();
  return (
    <List sort={{ field: "displayOrder", order: "ASC" }} perPage={100} pagination={false}>
      <SortableList
        resource="groups"
        columns={[
          { source: "nameEn", label: translate("padmakara.fields.nameEn") },
          { source: "namePt", label: translate("padmakara.fields.namePt") },
          { source: "abbreviation", label: translate("padmakara.fields.abbreviation"), width: 90 },
          { source: "slug", label: translate("padmakara.fields.slug") },
        ]}
      />
    </List>
  );
};

const EditToolbar = () => {
  const translate = useTranslate();
  const record = useRecordContext<GroupRecord>();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <Toolbar sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <SaveButton />
        {record && (
          <Button
            color="error"
            startIcon={<DeleteIcon />}
            onClick={() => setDialogOpen(true)}
          >
            {translate("padmakara.groups.delete")}
          </Button>
        )}
      </Toolbar>
      {record && (
        <DeleteGroupDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          group={record}
        />
      )}
    </>
  );
};

export const GroupEdit = () => {
  const translate = useTranslate();
  return (
    <Edit>
      <SimpleForm toolbar={<EditToolbar />}>
        <TextInput source="nameEn" label={translate("padmakara.fields.nameEn")} validate={required()} />
        <TextInput source="namePt" label={translate("padmakara.fields.namePt")} />
        <TextInput source="abbreviation" label={translate("padmakara.fields.abbreviation")} />
        <TextInput source="slug" label={translate("padmakara.fields.slug")} validate={required()} />
        <TextInput source="description" label={translate("padmakara.fields.description")} multiline />
        <GroupImageUpload />
        <TextInput source="logoUrl" label={translate("padmakara.fields.logoUrl")} helperText="Legacy field — replaced by Avatar above" />
      </SimpleForm>
    </Edit>
  );
};

export const GroupCreate = () => {
  const translate = useTranslate();
  return (
    <Create>
      <SimpleForm>
        <TextInput source="nameEn" label={translate("padmakara.fields.nameEn")} validate={required()} />
        <TextInput source="namePt" label={translate("padmakara.fields.namePt")} />
        <TextInput source="abbreviation" label={translate("padmakara.fields.abbreviation")} />
        <TextInput source="slug" label={translate("padmakara.fields.slug")} validate={required()} />
        <TextInput source="description" label={translate("padmakara.fields.description")} multiline />
        <TextInput source="logoUrl" label={translate("padmakara.fields.logoUrl")} />
      </SimpleForm>
    </Create>
  );
};

/* ───────────── Delete Confirmation Dialog ───────────── */

const DeleteGroupDialog = ({
  open,
  onClose,
  group,
}: {
  open: boolean;
  onClose: () => void;
  group: GroupRecord;
}) => {
  const translate = useTranslate();
  const notify = useNotify();
  const redirect = useRedirect();
  const dataProvider = useDataProvider();

  const [loading, setLoading] = useState(false);
  const [linkedEvents, setLinkedEvents] = useState<LinkedEvent[] | null>(null);
  const [otherGroups, setOtherGroups] = useState<GroupRecord[]>([]);
  const [reassignTo, setReassignTo] = useState<string>("");
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) {
      setConfirmText("");
      setReassignTo("");
      setLinkedEvents(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    Promise.all([
      authFetch(`${API_URL}/groups/${group.id}/events`).then((r) => r.json()),
      dataProvider.getList<GroupRecord>("groups", {
        pagination: { page: 1, perPage: 500 },
        sort: { field: "nameEn", order: "ASC" },
        filter: {},
      }),
    ])
      .then(([eventsRes, groupsRes]) => {
        if (cancelled) return;
        setLinkedEvents(eventsRes.events ?? []);
        setOtherGroups(groupsRes.data.filter((g) => g.id !== group.id));
      })
      .catch(() => {
        if (cancelled) return;
        setLinkedEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, group.id, dataProvider]);

  const confirmed = confirmText.toLowerCase() === "delete";
  const eventCount = linkedEvents?.length ?? 0;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const url =
        reassignTo === ""
          ? `${API_URL}/groups/${group.id}`
          : `${API_URL}/groups/${group.id}?reassignTo=${encodeURIComponent(reassignTo)}`;
      const res = await authFetch(url, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      notify(translate("padmakara.groups.deletedSuccess"), { type: "success" });
      redirect("list", "groups");
    } catch (error: any) {
      notify(`Error: ${error.message}`, { type: "error" });
    } finally {
      setDeleting(false);
      onClose();
    }
  };

  return (
    <Dialog open={open} onClose={deleting ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, color: "error.main" }}>
        {translate("padmakara.groups.deleteTitle")}
      </DialogTitle>
      <DialogContent>
        <Typography
          sx={{ mb: 2 }}
          dangerouslySetInnerHTML={{
            __html: translate("padmakara.groups.deleteConfirmMessage", {
              name: group.nameEn,
            }),
          }}
        />

        {loading && <LinearProgress sx={{ my: 2 }} />}

        {!loading && eventCount > 0 && (
          <>
            <Typography sx={{ mb: 1, fontWeight: 600 }}>
              {translate("padmakara.groups.deleteHasEvents", { count: eventCount })}
            </Typography>
            <Box
              sx={{
                maxHeight: 140,
                overflowY: "auto",
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 1,
                p: 1,
                mb: 2,
                bgcolor: "background.default",
              }}
            >
              {linkedEvents!.slice(0, 50).map((evt) => (
                <Typography
                  key={evt.id}
                  variant="body2"
                  sx={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {evt.eventCode} — {evt.titleEn}
                </Typography>
              ))}
              {linkedEvents!.length > 50 && (
                <Typography variant="caption" color="text.secondary">
                  …+{linkedEvents!.length - 50}
                </Typography>
              )}
            </Box>
          </>
        )}

        {!loading && otherGroups.length > 0 && (
          <FormControl fullWidth sx={{ mb: 2 }}>
            <InputLabel id="reassign-to-label">
              {translate("padmakara.groups.reassignLabel")}
            </InputLabel>
            <Select
              labelId="reassign-to-label"
              label={translate("padmakara.groups.reassignLabel")}
              value={reassignTo}
              onChange={(e) => setReassignTo(String(e.target.value))}
              disabled={deleting}
            >
              <MenuItem value="">
                <em>{translate("padmakara.groups.reassignPlaceholder")}</em>
              </MenuItem>
              {otherGroups.map((g) => (
                <MenuItem key={g.id} value={String(g.id)}>
                  {g.nameEn}
                </MenuItem>
              ))}
            </Select>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, ml: 0.5 }}>
              {translate("padmakara.groups.reassignHelper")}
            </Typography>
          </FormControl>
        )}

        <MuiTextField
          label={translate("padmakara.groups.deleteTypeConfirm")}
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          fullWidth
          autoFocus
          disabled={deleting}
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ "& input": { fontFamily: "monospace" } }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={deleting}>
          {translate("ra.action.cancel")}
        </Button>
        <Button
          variant="contained"
          color="error"
          startIcon={<DeleteIcon />}
          onClick={handleDelete}
          disabled={!confirmed || deleting || loading}
        >
          {deleting
            ? translate("padmakara.groups.deleting")
            : translate("padmakara.groups.deleteGroup")}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
