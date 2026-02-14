import { useState } from "react";
import {
  List,
  Datagrid,
  TextField,
  DateField,
  Edit,
  Create,
  SimpleForm,
  TextInput,
  required,
  EditButton,
  useTranslate,
  SaveButton,
  Toolbar,
  useRecordContext,
  useDelete,
  useNotify,
  useRedirect,
} from "react-admin";
import {
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField as MuiTextField,
  Typography,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";

function TypeToDeleteButton({ resource }: { resource: string }) {
  const record = useRecordContext();
  const notify = useNotify();
  const redirect = useRedirect();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [deleteOne, { isPending }] = useDelete();

  const handleDelete = () => {
    if (value !== "delete") return;
    deleteOne(
      resource,
      { id: record?.id },
      {
        onSuccess: () => {
          notify("Deleted", { type: "success" });
          redirect("list", resource);
        },
        onError: () => notify("Delete failed", { type: "error" }),
      },
    );
  };

  return (
    <>
      <Button
        color="error"
        startIcon={<DeleteIcon />}
        onClick={() => { setOpen(true); setValue(""); }}
        size="small"
      >
        Delete
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)}>
        <DialogTitle>Confirm deletion</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            This will remove the {resource.slice(0, -1)} from all associated events.
            Type <strong>delete</strong> to confirm.
          </Typography>
          <MuiTextField
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Type delete"
            size="small"
            fullWidth
            autoFocus
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            color="error"
            onClick={handleDelete}
            disabled={value !== "delete" || isPending}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

const TeacherToolbar = () => (
  <Toolbar sx={{ justifyContent: "space-between" }}>
    <SaveButton />
    <TypeToDeleteButton resource="teachers" />
  </Toolbar>
);

export const TeacherList = () => {
  const translate = useTranslate();
  return (
    <List sort={{ field: "name", order: "ASC" }} perPage={100} pagination={false}>
      <Datagrid rowClick="edit">
        <TextField source="name" label={translate("padmakara.fields.name")} />
        <TextField source="abbreviation" label={translate("padmakara.fields.abbreviation")} />
        <EditButton />
      </Datagrid>
    </List>
  );
};

export const TeacherEdit = () => {
  const translate = useTranslate();
  return (
    <Edit>
      <SimpleForm toolbar={<TeacherToolbar />}>
        <TextInput source="name" label={translate("padmakara.fields.name")} validate={required()} />
        <TextInput source="abbreviation" label={translate("padmakara.fields.abbreviation")} validate={required()} />
        <TextInput source="photoUrl" label={translate("padmakara.fields.photoUrl")} />
      </SimpleForm>
    </Edit>
  );
};

export const TeacherCreate = () => {
  const translate = useTranslate();
  return (
    <Create>
      <SimpleForm>
        <TextInput source="name" label={translate("padmakara.fields.name")} validate={required()} />
        <TextInput source="abbreviation" label={translate("padmakara.fields.abbreviation")} validate={required()} />
        <TextInput source="photoUrl" label={translate("padmakara.fields.photoUrl")} />
      </SimpleForm>
    </Create>
  );
};
