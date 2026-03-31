import { useState } from "react";
import {
  List,
  Datagrid,
  TextField,
  DateField,
  NumberField,
  Edit,
  Create,
  SimpleForm,
  TextInput,
  SelectInput,
  DateInput,
  NumberInput,
  ArrayInput,
  SimpleFormIterator,
  FunctionField,
  EditButton,
  required,
  SaveButton,
  Toolbar,
  useRecordContext,
  useDelete,
  useNotify,
  useRedirect,
  useTranslate,
} from "react-admin";
import {
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField as MuiTextField,
  Typography,
  Chip,
  Box,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";

const STATUS_CHOICES = [
  { id: "draft", name: "Draft" },
  { id: "published", name: "Published" },
  { id: "archived", name: "Archived" },
];

const ACCESS_LEVEL_CHOICES = [
  { id: "public", name: "Public" },
  { id: "free-subscribers", name: "Free Subscribers" },
  { id: "retreat-group-members", name: "Retreat Group Members" },
  { id: "event-participants", name: "Event Participants" },
];

const LANGUAGE_CHOICES = [
  { id: "pt", name: "Portuguese" },
  { id: "en", name: "English" },
  { id: "tib", name: "Tibetan" },
];

const statusColors: Record<string, "default" | "success" | "warning"> = {
  draft: "warning",
  published: "success",
  archived: "default",
};

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
            This will permanently remove the publication.
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

const PublicationToolbar = () => (
  <Toolbar sx={{ justifyContent: "space-between" }}>
    <SaveButton />
    <TypeToDeleteButton resource="publications" />
  </Toolbar>
);

const publicationFilters = [
  <SelectInput key="status" source="status" choices={STATUS_CHOICES} alwaysOn />,
  <SelectInput key="accessLevel" source="accessLevel" label="Access Level" choices={ACCESS_LEVEL_CHOICES} />,
];

export const PublicationList = () => {
  const translate = useTranslate();
  return (
    <List
      sort={{ field: "sortOrder", order: "ASC" }}
      perPage={25}
      filters={publicationFilters}
    >
      <Datagrid rowClick="edit">
        <FunctionField
          label="Cover"
          render={(record: { coverImageS3Key?: string; titlePt?: string }) =>
            record?.coverImageS3Key ? (
              <Box
                component="img"
                src={`/api/admin/publications/${record.coverImageS3Key}/cover`}
                alt={record.titlePt || "Cover"}
                sx={{ width: 40, height: 56, objectFit: "cover", borderRadius: 0.5 }}
              />
            ) : (
              <Box
                sx={{
                  width: 40,
                  height: 56,
                  bgcolor: "grey.200",
                  borderRadius: 0.5,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.6rem",
                  color: "grey.500",
                }}
              >
                PDF
              </Box>
            )
          }
        />
        <TextField source="titlePt" label="Title (PT)" />
        <TextField source="subtitle" label="Subtitle" />
        <TextField source="language" label="Language" />
        <FunctionField
          label="Access"
          render={(record: { accessLevel?: string }) => (
            <Chip label={record?.accessLevel || "public"} size="small" variant="outlined" />
          )}
        />
        <FunctionField
          label="Status"
          render={(record: { status?: string }) => (
            <Chip
              label={record?.status || "draft"}
              size="small"
              color={statusColors[record?.status || "draft"] || "default"}
            />
          )}
        />
        <DateField source="publicationDate" label="Publication Date" />
        <NumberField source="pageCount" label="Pages" />
        <EditButton />
      </Datagrid>
    </List>
  );
};

export const PublicationEdit = () => {
  const translate = useTranslate();
  return (
    <Edit>
      <SimpleForm toolbar={<PublicationToolbar />}>
        <TextInput source="titlePt" label="Title (PT)" validate={required()} fullWidth />
        <TextInput source="titleEn" label="Title (EN)" fullWidth />
        <TextInput source="subtitle" label="Subtitle" fullWidth />
        <TextInput source="description" label="Description" multiline rows={4} fullWidth />
        <ArrayInput source="authors" label="Authors">
          <SimpleFormIterator inline>
            <TextInput source="" label="Author name" helperText={false} />
          </SimpleFormIterator>
        </ArrayInput>
        <SelectInput source="language" label="Language" choices={LANGUAGE_CHOICES} validate={required()} />
        <DateInput source="publicationDate" label="Publication Date" />
        <SelectInput source="accessLevel" label="Access Level" choices={ACCESS_LEVEL_CHOICES} validate={required()} />
        <SelectInput source="status" label="Status" choices={STATUS_CHOICES} validate={required()} />
        <TextInput source="pdfS3Key" label="PDF S3 Key" validate={required()} fullWidth />
        <TextInput source="coverImageS3Key" label="Cover Image S3 Key" fullWidth />
        <NumberField source="pageCount" label="Pages" />
        <NumberField source="fileSizeBytes" label="File Size (bytes)" />
        <NumberInput source="sortOrder" label="Sort Order" />
      </SimpleForm>
    </Edit>
  );
};

export const PublicationCreate = () => {
  const translate = useTranslate();
  return (
    <Create>
      <SimpleForm>
        <TextInput source="titlePt" label="Title (PT)" validate={required()} fullWidth />
        <TextInput source="titleEn" label="Title (EN)" fullWidth />
        <TextInput source="subtitle" label="Subtitle" fullWidth />
        <TextInput source="description" label="Description" multiline rows={4} fullWidth />
        <ArrayInput source="authors" label="Authors">
          <SimpleFormIterator inline>
            <TextInput source="" label="Author name" helperText={false} />
          </SimpleFormIterator>
        </ArrayInput>
        <SelectInput source="language" label="Language" choices={LANGUAGE_CHOICES} validate={required()} />
        <DateInput source="publicationDate" label="Publication Date" />
        <SelectInput source="accessLevel" label="Access Level" choices={ACCESS_LEVEL_CHOICES} defaultValue="public" validate={required()} />
        <SelectInput source="status" label="Status" choices={STATUS_CHOICES} defaultValue="draft" validate={required()} />
        <TextInput source="pdfS3Key" label="PDF S3 Key" validate={required()} fullWidth />
        <TextInput source="coverImageS3Key" label="Cover Image S3 Key" fullWidth />
        <NumberInput source="sortOrder" label="Sort Order" defaultValue={0} />
      </SimpleForm>
    </Create>
  );
};
