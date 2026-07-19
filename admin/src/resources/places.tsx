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
  const translate = useTranslate();
  const notify = useNotify();
  const redirect = useRedirect();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [deleteOne, { isPending }] = useDelete();
  const resourceLabel = translate(`resources.${resource}.name`, { smart_count: 1 }).toLowerCase();

  const handleDelete = () => {
    if (value !== "delete") return;
    deleteOne(
      resource,
      { id: record?.id },
      {
        onSuccess: () => {
          notify(translate("padmakara.common.deleted"), { type: "success" });
          redirect("list", resource);
        },
        onError: () => notify(translate("padmakara.common.deleteFailed"), { type: "error" }),
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
        {translate("ra.action.delete")}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)}>
        <DialogTitle>{translate("padmakara.common.confirmDeletion")}</DialogTitle>
        <DialogContent>
          <Typography
            variant="body2"
            sx={{ mb: 2 }}
            dangerouslySetInnerHTML={{
              __html: translate("padmakara.common.deleteAssociatedWarning", {
                resource: resourceLabel,
              }),
            }}
          />
          <MuiTextField
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={translate("padmakara.common.typeDeletePlaceholder")}
            size="small"
            fullWidth
            autoFocus
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{translate("ra.action.cancel")}</Button>
          <Button
            color="error"
            onClick={handleDelete}
            disabled={value !== "delete" || isPending}
          >
            {translate("ra.action.delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

const PlaceToolbar = () => (
  <Toolbar sx={{ justifyContent: "space-between" }}>
    <SaveButton />
    <TypeToDeleteButton resource="places" />
  </Toolbar>
);

export const PlaceList = () => {
  const translate = useTranslate();
  return (
    <List sort={{ field: "name", order: "ASC" }} perPage={100} pagination={false}>
      <Datagrid rowClick="edit">
        <TextField source="name" label={translate("padmakara.fields.name")} />
        <TextField source="abbreviation" label={translate("padmakara.fields.abbreviation")} />
        <TextField source="location" label={translate("padmakara.fields.location")} />
        <EditButton />
      </Datagrid>
    </List>
  );
};

export const PlaceEdit = () => {
  const translate = useTranslate();
  return (
    <Edit>
      <SimpleForm toolbar={<PlaceToolbar />}>
        <TextInput source="name" label={translate("padmakara.fields.name")} validate={required()} />
        <TextInput source="abbreviation" label={translate("padmakara.fields.abbreviation")} />
        <TextInput source="location" label={translate("padmakara.fields.location")} />
      </SimpleForm>
    </Edit>
  );
};

export const PlaceCreate = () => {
  const translate = useTranslate();
  return (
    <Create>
      <SimpleForm>
        <TextInput source="name" label={translate("padmakara.fields.name")} validate={required()} />
        <TextInput source="abbreviation" label={translate("padmakara.fields.abbreviation")} />
        <TextInput source="location" label={translate("padmakara.fields.location")} />
      </SimpleForm>
    </Create>
  );
};
