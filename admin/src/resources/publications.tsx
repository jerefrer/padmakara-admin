import { useState, useRef } from "react";
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
  CircularProgress,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";

const STATUS_CHOICES = [
  { id: "draft", name: "Draft" },
  { id: "published", name: "Published" },
  { id: "archived", name: "Archived" },
];

const ACCESS_LEVEL_CHOICES = [
  { id: "public", name: "Public" },
  { id: "subscribers", name: "Subscribers" },
];

const LANGUAGE_CHOICES = [
  { id: "pt", name: "Portuguese" },
  { id: "en", name: "English" },
  { id: "fr", name: "French" },
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

// ─── List ────────────────────────────────────────────────────────────────────

export const PublicationList = () => (
  <List
    sort={{ field: "publicationDate", order: "DESC" }}
    perPage={25}
    filters={publicationFilters}
  >
    <Datagrid rowClick="edit">
      <FunctionField
        label="Cover"
        render={(record: { coverImageS3Key?: string; title?: string }) =>
          record?.coverImageS3Key ? (
            <Box
              component="img"
              src={`/api/admin/publications/${record.coverImageS3Key}/cover`}
              alt={record.title || "Cover"}
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
      <TextField source="title" label="Title" />
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

// ─── Edit ────────────────────────────────────────────────────────────────────

export const PublicationEdit = () => (
  <Edit>
    <SimpleForm toolbar={<PublicationToolbar />}>
      <TextInput source="title" label="Title" validate={required()} fullWidth />
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
      <TextInput source="pdfS3Key" label="PDF S3 Key" validate={required()} fullWidth disabled />
      <TextInput source="coverImageS3Key" label="Cover Image S3 Key" fullWidth />
      <NumberField source="pageCount" label="Pages" />
      <NumberField source="fileSizeBytes" label="File Size (bytes)" />
    </SimpleForm>
  </Edit>
);

// ─── Create ──────────────────────────────────────────────────────────────────

interface ExtractedMetadata {
  title?: string;
  subtitle?: string;
  description?: string;
  authors?: string[];
  language?: string;
  publicationDate?: string;
  pageCount?: number;
  fileSizeBytes?: number;
  coverImageS3Key?: string;
}

export const PublicationCreate = () => {
  const [phase, setPhase] = useState<"upload" | "extracting" | "form">("upload");
  const [isDragging, setIsDragging] = useState(false);
  const [extractionStatus, setExtractionStatus] = useState("Uploading PDF...");
  const [defaultValues, setDefaultValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
  const token = localStorage.getItem("auth_token");

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== "application/pdf") {
      setError("Please select a PDF file.");
      return;
    }

    setError(null);
    setPhase("extracting");
    setExtractionStatus("Uploading PDF...");

    try {
      // 1. Get presigned upload URL
      const presignRes = await fetch(`${apiUrl}/admin/publications/presign-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ filename: file.name, contentType: file.type, type: "pdf" }),
      });
      if (!presignRes.ok) throw new Error("Failed to get upload URL");
      const { s3Key, uploadUrl } = await presignRes.json();

      // 2. Upload PDF to S3
      setExtractionStatus("Uploading PDF to storage...");
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadRes.ok) throw new Error("Failed to upload PDF");

      // 3. Extract metadata using Claude
      setExtractionStatus("Extracting metadata from PDF (this may take a moment)...");
      const extractRes = await fetch(`${apiUrl}/admin/publications/extract-metadata`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pdfS3Key: s3Key }),
      });
      if (!extractRes.ok) throw new Error("Failed to extract metadata");
      const metadata: ExtractedMetadata = await extractRes.json();

      // 4. Set default values and switch to form phase
      setDefaultValues({
        title: metadata.title || "",
        subtitle: metadata.subtitle || "",
        description: metadata.description || "",
        authors: metadata.authors || [],
        language: metadata.language || "pt",
        publicationDate: metadata.publicationDate || undefined,
        accessLevel: "public",
        status: "draft",
        pdfS3Key: s3Key,
        coverImageS3Key: metadata.coverImageS3Key || "",
        pageCount: metadata.pageCount || undefined,
        fileSizeBytes: metadata.fileSizeBytes || file.size,
      });
      setPhase("form");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
      setPhase("upload");
    }
  };

  if (phase === "extracting") {
    return (
      <Create>
        <Box sx={{ p: 6, textAlign: "center" }}>
          <CircularProgress sx={{ mb: 3 }} />
          <Typography variant="h6" gutterBottom>
            Processing PDF
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {extractionStatus}
          </Typography>
        </Box>
      </Create>
    );
  }

  if (phase === "form") {
    return (
      <Create record={defaultValues}>
        <SimpleForm>
          <TextInput source="title" label="Title" validate={required()} fullWidth />
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
          <TextInput source="pdfS3Key" label="PDF S3 Key" validate={required()} fullWidth disabled />
          <TextInput source="coverImageS3Key" label="Cover Image S3 Key" fullWidth />
          <NumberField source="pageCount" label="Pages" />
          <NumberField source="fileSizeBytes" label="File Size (bytes)" />
        </SimpleForm>
      </Create>
    );
  }

  // Phase: upload
  return (
    <Create>
      <Box sx={{ p: 4 }}>
        <Typography variant="h6" gutterBottom>
          New Publication
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Upload a PDF to automatically extract metadata and pre-fill the form.
        </Typography>

        {error && (
          <Typography variant="body2" color="error" sx={{ mb: 2 }}>
            {error}
          </Typography>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          style={{ display: "none" }}
          onChange={(e) => handleFile(e.target.files?.[0])}
        />

        <Box
          sx={{
            border: "2px dashed",
            borderColor: isDragging ? "primary.main" : "grey.400",
            borderRadius: 2,
            p: 6,
            textAlign: "center",
            cursor: "pointer",
            bgcolor: isDragging ? "action.hover" : "background.paper",
            transition: "all 0.2s",
          }}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFile(e.dataTransfer.files[0]); }}
          onClick={() => fileInputRef.current?.click()}
        >
          <CloudUploadIcon sx={{ fontSize: 48, color: "grey.500", mb: 1 }} />
          <Typography variant="body1" gutterBottom>
            Drag and drop a PDF here, or click to browse
          </Typography>
          <Typography variant="caption" color="text.secondary">
            PDF files only
          </Typography>
        </Box>
      </Box>
    </Create>
  );
};
