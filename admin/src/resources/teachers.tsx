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
  FunctionField,
} from "react-admin";
import { TeacherImageUpload } from "../components/TeacherImageUpload";
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
        <FunctionField
          label=""
          render={(record: any) =>
            (record?.avatarUrl || record?.photoUrl) ? (
              <img src={(record.avatarUrl || record.photoUrl) as string} alt="" style={{ width: 32, height: 32, borderRadius: 16, objectFit: "cover" }} />
            ) : (
              <div style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#4b5563" }}>
                {(record?.name || "?").split(" ").map((w: string) => w[0]).join("").substring(0, 2).toUpperCase()}
              </div>
            )
          }
        />
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
        <TeacherImageUpload />
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
      </SimpleForm>
    </Create>
  );
};
