import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import DeleteIcon from "@mui/icons-material/Delete";
import ImageIcon from "@mui/icons-material/Image";
import {
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  TextField as MuiTextField,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFormContext } from "react-hook-form";
import { authFetch } from "../utils/authFetch";
import {
  Create,
  Datagrid,
  DateField,
  DateInput,
  Edit,
  EditButton,
  FunctionField,
  List,
  NumberField,
  required,
  SaveButton,
  SelectInput,
  SimpleForm,
  TextField,
  TextInput,
  Toolbar,
  useDataProvider,
  useDelete,
  useNotify,
  useRecordContext,
  useRedirect,
  useTranslate,
} from "react-admin";

const ACCESS_LEVEL_CHOICES = [
  { id: "public", name: "padmakara.publications.accessPublic" },
  { id: "subscribers", name: "padmakara.publications.accessSubscribers" },
];

const LANGUAGE_CHOICES = [
  { id: "pt", name: "padmakara.publications.langPt" },
  { id: "en", name: "padmakara.publications.langEn" },
  { id: "fr", name: "padmakara.publications.langFr" },
  { id: "tib", name: "padmakara.publications.langTib" },
];


interface TeacherOption {
  id: number;
  name: string;
  abbreviation: string;
}

// ─── Shared Components ─────────────────────────────────────────────────────

function TypeToDeleteButton({ resource }: { resource: string }) {
  const record = useRecordContext();
  const translate = useTranslate();
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
        onClick={() => {
          setOpen(true);
          setValue("");
        }}
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
            dangerouslySetInnerHTML={{ __html: translate("padmakara.publications.deleteWarning") }}
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

const PublicationToolbar = () => (
  <Toolbar sx={{ justifyContent: "space-between" }}>
    <SaveButton />
    <TypeToDeleteButton resource="publications" />
  </Toolbar>
);

/** Save button that creates via dataProvider */
function CreateSaveButton({
  defaultValues,
  selectedAuthors,
}: {
  defaultValues: Record<string, unknown>;
  selectedAuthors: string[];
}) {
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const redirect = useRedirect();
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await dataProvider.create("publications", {
        data: { ...defaultValues, authors: selectedAuthors },
      });
      notify(translate("padmakara.publications.created"), { type: "success" });
      redirect("list", "publications");
    } catch {
      notify(translate("padmakara.publications.createFailed"), { type: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Button
      variant="contained"
      onClick={handleSave}
      disabled={saving || !defaultValues.title}
      startIcon={saving ? <CircularProgress size={18} /> : undefined}
    >
      {saving ? translate("padmakara.events.saving") : translate("ra.action.save")}
    </Button>
  );
}

/** Cover image preview with optional replace button */
function CoverPreview({
  url,
  onReplace,
}: {
  url: string | null;
  onReplace?: () => void;
}) {
  const translate = useTranslate();
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 1,
        minWidth: 120,
      }}
    >
      {url ? (
        <Box
          component="img"
          src={url}
          alt={translate("padmakara.publications.coverPreviewAlt")}
          sx={{
            width: 120,
            height: "auto",
            objectFit: "cover",
          }}
        />
      ) : (
        <Box
          sx={{
            width: 120,
            height: 160,
            bgcolor: "grey.100",
            borderRadius: 1,
            border: "1px dashed",
            borderColor: "grey.400",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "grey.500",
            fontSize: "0.75rem",
          }}
        >
          {translate("padmakara.publications.noCover")}
        </Box>
      )}
      {onReplace && (
        <Button
          size="small"
          startIcon={<ImageIcon />}
          onClick={onReplace}
          sx={{ textTransform: "none" }}
        >
          {url ? translate("padmakara.publications.replace") : translate("padmakara.publications.uploadCoverButton")}
        </Button>
      )}
    </Box>
  );
}

function useTeachers() {
  const dataProvider = useDataProvider();
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);

  useEffect(() => {
    dataProvider
      .getList<TeacherOption>("teachers", {
        pagination: { page: 1, perPage: 500 },
        sort: { field: "name", order: "ASC" },
        filter: {},
      })
      .then(({ data }) => setTeachers(data));
  }, [dataProvider]);

  return teachers;
}

// ─── List ────────────────────────────────────────────────────────────────────

const publicationFilters = [
  <SelectInput
    key="accessLevel"
    source="accessLevel"
    label="padmakara.publications.accessLevel"
    choices={ACCESS_LEVEL_CHOICES}
    alwaysOn
  />,
];

export const PublicationList = () => {
  const translate = useTranslate();
  return (
    <List
      sort={{ field: "publicationDate", order: "DESC" }}
      perPage={25}
      filters={publicationFilters}
    >
      <Datagrid rowClick="edit">
        <FunctionField
          label={translate("padmakara.publications.coverColumnLabel")}
          render={(record: { coverImageUrl?: string; title?: string }) =>
            record?.coverImageUrl ? (
              <Box
                component="img"
                src={record.coverImageUrl}
                alt={record.title || translate("padmakara.publications.coverColumnLabel")}
                sx={{ width: 40, height: "auto", objectFit: "cover" }}
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
        <TextField source="title" label="padmakara.events.title" />
        <TextField source="language" label="padmakara.publications.language" />
        <FunctionField
          label={translate("padmakara.publications.authors")}
          render={(record: { authors?: string[] }) =>
            (record?.authors || []).join(", ") || "\u2014"
          }
        />
        <FunctionField
          label={translate("padmakara.publications.access")}
          render={(record: { accessLevel?: string }) => {
            const choice = ACCESS_LEVEL_CHOICES.find(
              (c) => c.id === (record?.accessLevel || "public"),
            );
            return (
              <Chip
                label={translate(choice?.name ?? "padmakara.publications.accessPublic")}
                size="small"
                variant="outlined"
              />
            );
          }}
        />
        <DateField source="publicationDate" label="padmakara.events.published" />
        <NumberField source="pageCount" label="padmakara.publications.pages" />
        <EditButton />
      </Datagrid>
    </List>
  );
};

// ─── Edit ────────────────────────────────────────────────────────────────────

/**
 * PDF replacement zone shown on the Edit form. Supports drag-and-drop, with
 * optional re-extraction of textual metadata (title, subtitle, etc — off by
 * default to avoid silently overwriting human-edited fields). The cover is
 * ALWAYS regenerated server-side from the new PDF on save, because the version
 * label on Padmakara covers means the old auto-cover is no longer accurate.
 */
function PdfReplaceSection() {
  const translate = useTranslate();
  const notify = useNotify();
  const { setValue } = useFormContext();
  const [uploading, setUploading] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [extractMeta, setExtractMeta] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== "application/pdf") {
      notify(translate("padmakara.publications.selectPdfFile"), { type: "error" });
      return;
    }

    setUploading(true);
    try {
      // 1. Presign upload
      setStatusText(translate("padmakara.publications.requestingUploadUrl"));
      const presignRes = await authFetch(
        "/api/admin/publications/presign-upload",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type,
            type: "pdf",
          }),
        },
      );
      if (!presignRes.ok) throw new Error(translate("padmakara.publications.failedGetUploadUrl"));
      const { s3Key, uploadUrl } = await presignRes.json();

      // 2. Upload PDF
      setStatusText(translate("padmakara.publications.uploadingPdfToStorage"));
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadRes.ok) throw new Error(translate("padmakara.publications.uploadFailed"));

      // 3. Optionally re-extract textual metadata. The cover is always
      // regenerated server-side on save (PUT /:id detects the PDF change),
      // so we don't touch coverImageS3Key here regardless of the checkbox.
      if (extractMeta) {
        setStatusText(translate("padmakara.publications.extractingMetadataStatus"));
        const extractRes = await authFetch(
          "/api/admin/publications/extract-metadata",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pdfS3Key: s3Key }),
          },
        );
        if (!extractRes.ok) throw new Error(translate("padmakara.publications.metadataExtractionFailed"));
        const meta = await extractRes.json();

        if (meta.title) setValue("title", meta.title, { shouldDirty: true });
        if (meta.subtitle !== undefined)
          setValue("subtitle", meta.subtitle, { shouldDirty: true });
        if (meta.description !== undefined)
          setValue("description", meta.description, { shouldDirty: true });
        if (Array.isArray(meta.authors) && meta.authors.length > 0)
          setValue("authors", meta.authors, { shouldDirty: true });
        if (meta.language)
          setValue("language", meta.language, { shouldDirty: true });
        if (meta.publicationDate)
          setValue("publicationDate", meta.publicationDate, {
            shouldDirty: true,
          });
        if (meta.version)
          setValue("version", meta.version, { shouldDirty: true });
        if (typeof meta.pageCount === "number")
          setValue("pageCount", meta.pageCount, { shouldDirty: true });
        if (typeof meta.fileSizeBytes === "number")
          setValue("fileSizeBytes", meta.fileSizeBytes, { shouldDirty: true });
      } else {
        // Backend re-derives pageCount/fileSizeBytes server-side from the new
        // pdfS3Key on save. Surface the local file size immediately for UX.
        setValue("fileSizeBytes", file.size, { shouldDirty: true });
      }

      setValue("pdfS3Key", s3Key, { shouldDirty: true });

      notify(
        extractMeta
          ? translate("padmakara.publications.pdfReplacedReextracted")
          : translate("padmakara.publications.pdfReplacedCoverRegenerated"),
        { type: "info" },
      );
    } catch (err) {
      notify(
        err instanceof Error ? err.message : translate("padmakara.publications.failedReplacePdf"),
        { type: "error" },
      );
    } finally {
      setUploading(false);
      setStatusText("");
    }
  };

  return (
    <Box sx={{ width: "100%" }}>
      <Typography
        variant="subtitle2"
        sx={{ fontWeight: 600, mb: 1, color: "text.secondary" }}
      >
        {translate("padmakara.publications.replacePdfHeading")}
      </Typography>

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
          borderColor: isDragging
            ? "primary.main"
            : uploading
              ? "primary.light"
              : "grey.400",
          borderRadius: 2,
          p: 3,
          textAlign: "center",
          cursor: uploading ? "default" : "pointer",
          bgcolor: isDragging ? "action.hover" : "background.paper",
          transition: "all 0.2s",
          opacity: uploading ? 0.7 : 1,
        }}
        onDragOver={(e) => {
          if (uploading) return;
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (uploading) return;
          handleFile(e.dataTransfer.files[0]);
        }}
        onClick={() => {
          if (!uploading) fileInputRef.current?.click();
        }}
      >
        {uploading ? (
          <Box>
            <CircularProgress size={24} sx={{ mb: 1 }} />
            <Typography variant="body2" color="text.secondary">
              {statusText}
            </Typography>
          </Box>
        ) : (
          <>
            <CloudUploadIcon sx={{ fontSize: 32, color: "grey.500", mb: 0.5 }} />
            <Typography variant="body2">
              {translate("padmakara.publications.dragDropPdf")}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {translate("padmakara.publications.coverRegeneratedNote")}
            </Typography>
          </>
        )}
      </Box>

      <FormControlLabel
        sx={{ mt: 1 }}
        control={
          <Checkbox
            checked={extractMeta}
            onChange={(e) => setExtractMeta(e.target.checked)}
            size="small"
            disabled={uploading}
          />
        }
        label={
          <Typography variant="body2">
            {translate("padmakara.publications.reextractMetadataLabel")}
          </Typography>
        }
      />
    </Box>
  );
}

export const PublicationEdit = () => {
  const translate = useTranslate();
  return (
    <Edit>
      <SimpleForm toolbar={<PublicationToolbar />}>
        <Box sx={{ display: "flex", gap: 3, width: "100%" }}>
          {/* Left: Cover + info */}
          <Box sx={{ flexShrink: 0 }}>
            <FunctionField
              label={false}
              render={(record: { coverImageUrl?: string }) => (
                <CoverPreview url={record?.coverImageUrl || null} />
              )}
            />
            <FunctionField
              label={false}
              render={(record: { pageCount?: number; fileSizeBytes?: number }) => {
                const pages = record?.pageCount;
                const bytes = record?.fileSizeBytes;
                if (!pages && !bytes) return null;
                return (
                  <Box sx={{ display: "flex", gap: 0.5, mt: 1, flexWrap: "wrap", justifyContent: "center" }}>
                    {pages ? (
                      <Chip
                        label={translate("padmakara.publications.pagesChip", { smart_count: pages })}
                        size="small"
                        variant="outlined"
                        sx={{ fontSize: "0.7rem" }}
                      />
                    ) : null}
                    {bytes ? <Chip label={bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`} size="small" variant="outlined" sx={{ fontSize: "0.7rem" }} /> : null}
                  </Box>
                );
              }}
            />
          </Box>

          {/* Right: All form fields */}
          <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            <TextInput source="title" label="padmakara.events.title" validate={required()} fullWidth />
            <TextInput source="subtitle" label="padmakara.publications.subtitle" fullWidth />
            <TextInput source="description" label="padmakara.fields.description" multiline rows={3} fullWidth />
            <TextInput
              source="authors"
              label="padmakara.publications.authors"
              format={(v: string[]) => (v || []).join(", ")}
              parse={(v: string) => v.split(",").map((s: string) => s.trim()).filter(Boolean)}
              fullWidth
              helperText={translate("padmakara.publications.authorsHelper")}
            />
            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "flex-start" }}>
              <SelectInput source="language" label="padmakara.publications.language" choices={LANGUAGE_CHOICES} validate={required()} />
              <DateInput source="publicationDate" label="padmakara.publications.publicationDate" />
              <TextInput source="version" label="padmakara.publications.version" helperText={translate("padmakara.publications.versionHelper")} />
              <SelectInput source="accessLevel" label="padmakara.publications.accessLevel" choices={ACCESS_LEVEL_CHOICES} validate={required()} />
            </Box>

            <Box sx={{ mt: 2, pt: 2, borderTop: "1px solid", borderColor: "divider" }}>
              <PdfReplaceSection />
            </Box>
          </Box>
        </Box>
      </SimpleForm>
    </Edit>
  );
};

// ─── Create ──────────────────────────────────────────────────────────────────

interface ExtractedMetadata {
  title?: string;
  subtitle?: string;
  description?: string;
  authors?: string[];
  language?: string;
  publicationDate?: string;
  version?: string;
  pageCount?: number;
  fileSizeBytes?: number;
  coverImageS3Key?: string;
  coverImageUrl?: string;
  matchedTeacherIds?: number[];
}

export const PublicationCreate = () => {
  const translate = useTranslate();
  const [phase, setPhase] = useState<"upload" | "extracting" | "form">(
    "upload",
  );
  const [isDragging, setIsDragging] = useState(false);
  const [extractionStatus, setExtractionStatus] = useState(
    translate("padmakara.publications.uploadingPdf"),
  );
  const [defaultValues, setDefaultValues] = useState<Record<string, unknown>>(
    {},
  );
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  const allTeachers = useTeachers();

  // Build author suggestions from teachers + extracted authors
  const authorSuggestions = allTeachers.map(
    (t) => `${t.name} (${t.abbreviation})`,
  );

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== "application/pdf") {
      setError(translate("padmakara.publications.selectPdfFile"));
      return;
    }

    setError(null);
    setPhase("extracting");
    setExtractionStatus(translate("padmakara.publications.uploadingPdf"));

    try {
      // 1. Get presigned upload URL
      const presignRes = await authFetch(`/api/admin/publications/presign-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          type: "pdf",
        }),
      });
      if (!presignRes.ok) throw new Error(translate("padmakara.publications.failedGetUploadUrl"));
      const { s3Key, uploadUrl } = await presignRes.json();

      // 2. Upload PDF to S3 (presigned URL — no auth header)
      setExtractionStatus(translate("padmakara.publications.uploadingPdfToStorage"));
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!uploadRes.ok) throw new Error(translate("padmakara.publications.failedUploadPdf"));

      // 3. Extract metadata using Claude
      setExtractionStatus(translate("padmakara.publications.extractingMetadataLong"));
      const extractRes = await authFetch(
        `/api/admin/publications/extract-metadata`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pdfS3Key: s3Key }),
        },
      );
      if (!extractRes.ok) throw new Error(translate("padmakara.publications.failedExtractMetadata"));
      const metadata: ExtractedMetadata = await extractRes.json();

      // Pre-select authors from extraction
      const extractedAuthors = metadata.authors || [];
      setSelectedAuthors(extractedAuthors);
      setCoverPreviewUrl(metadata.coverImageUrl || null);

      // 4. Set default values and switch to form phase
      setDefaultValues({
        title: metadata.title || "",
        subtitle: metadata.subtitle || "",
        description: metadata.description || "",
        authors: extractedAuthors,
        language: metadata.language || "pt",
        publicationDate: metadata.publicationDate || undefined,
        version: metadata.version || "",
        accessLevel: "public",
        pdfS3Key: s3Key,
        coverImageS3Key: metadata.coverImageS3Key || "",
        pageCount: metadata.pageCount || undefined,
        fileSizeBytes: metadata.fileSizeBytes || file.size,
      });
      setPhase("form");
    } catch (err) {
      setError(err instanceof Error ? err.message : translate("padmakara.publications.errorOccurred"));
      setPhase("upload");
    }
  };

  const handleCoverReplace = useCallback(
    async (file: File) => {
      try {
        const presignRes = await authFetch(
          `/api/admin/publications/presign-upload`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filename: file.name,
              contentType: file.type,
              type: "cover",
            }),
          },
        );
        if (!presignRes.ok) throw new Error(translate("padmakara.publications.failedGetCoverUploadUrl"));
        const { s3Key, uploadUrl } = await presignRes.json();

        await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });

        setCoverPreviewUrl(URL.createObjectURL(file));
        setDefaultValues((prev) => ({ ...prev, coverImageS3Key: s3Key }));
      } catch {
        setError(translate("padmakara.publications.failedUploadCoverImage"));
      }
    },
    [translate],
  );

  if (phase === "extracting") {
    return (
      <Create>
        <Box sx={{ p: 6, textAlign: "center" }}>
          <CircularProgress sx={{ mb: 3 }} />
          <Typography variant="h6" gutterBottom>
            {translate("padmakara.publications.processingPdf")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {extractionStatus}
          </Typography>
        </Box>
      </Create>
    );
  }

  if (phase === "form") {
    const pages = defaultValues.pageCount as number | undefined;
    const bytes = defaultValues.fileSizeBytes as number | undefined;

    return (
      <Create title={translate("padmakara.publications.createPageTitle")}>
        <Box sx={{ p: 3 }}>
          <Typography variant="h6" sx={{ mb: 3 }}>
            {translate("padmakara.publications.newPublicationHeading")}
          </Typography>

          <Box sx={{ display: "flex", gap: 3 }}>
            {/* Left: Cover + info */}
            <Box sx={{ flexShrink: 0 }}>
              <CoverPreview
                url={coverPreviewUrl}
                onReplace={() => coverInputRef.current?.click()}
              />
              <input
                ref={coverInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleCoverReplace(f);
                }}
              />
              {/* Info chips under cover */}
              {(pages || bytes) && (
                <Box
                  sx={{
                    display: "flex",
                    gap: 0.5,
                    mt: 1,
                    flexWrap: "wrap",
                    justifyContent: "center",
                  }}
                >
                  {pages && (
                    <Chip
                      label={translate("padmakara.publications.pagesChip", { smart_count: pages })}
                      size="small"
                      variant="outlined"
                      sx={{ fontSize: "0.7rem" }}
                    />
                  )}
                  {bytes && (
                    <Chip
                      label={
                        bytes >= 1048576
                          ? `${(bytes / 1048576).toFixed(1)} MB`
                          : `${Math.round(bytes / 1024)} KB`
                      }
                      size="small"
                      variant="outlined"
                      sx={{ fontSize: "0.7rem" }}
                    />
                  )}
                </Box>
              )}
            </Box>

            {/* Right: All form fields */}
            <Box
              sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}
            >
              <MuiTextField
                label={translate("padmakara.events.title")}
                required
                fullWidth
                defaultValue={defaultValues.title as string}
                onChange={(e) =>
                  setDefaultValues((prev) => ({
                    ...prev,
                    title: e.target.value,
                  }))
                }
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <MuiTextField
                label={translate("padmakara.publications.subtitle")}
                fullWidth
                defaultValue={defaultValues.subtitle as string}
                onChange={(e) =>
                  setDefaultValues((prev) => ({
                    ...prev,
                    subtitle: e.target.value,
                  }))
                }
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <MuiTextField
                label={translate("padmakara.fields.description")}
                fullWidth
                multiline
                rows={3}
                defaultValue={defaultValues.description as string}
                onChange={(e) =>
                  setDefaultValues((prev) => ({
                    ...prev,
                    description: e.target.value,
                  }))
                }
                slotProps={{ inputLabel: { shrink: true } }}
              />

              {/* Authors */}
              <Autocomplete
                multiple
                freeSolo
                options={authorSuggestions}
                value={selectedAuthors}
                onChange={(_, v) => {
                  setSelectedAuthors(v as string[]);
                  setDefaultValues((prev) => ({ ...prev, authors: v }));
                }}
                renderTags={(value, getTagProps) =>
                  value.map((option, index) => {
                    const { key, ...rest } = getTagProps({ index });
                    return (
                      <Chip key={key} label={option} size="small" {...rest} />
                    );
                  })
                }
                renderInput={(params) => (
                  <MuiTextField
                    {...params}
                    label={translate("padmakara.publications.authors")}
                    placeholder={translate("padmakara.publications.authorsPlaceholder")}
                    slotProps={{ inputLabel: { shrink: true } }}
                  />
                )}
              />

              {/* Language, Date, Access, Status */}
              <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "flex-start" }}>
                <MuiTextField
                  label={translate("padmakara.publications.language")}
                  select
                  value={(defaultValues.language as string) || "pt"}
                  onChange={(e) =>
                    setDefaultValues((prev) => ({
                      ...prev,
                      language: e.target.value,
                    }))
                  }
                  slotProps={{ inputLabel: { shrink: true } }}
                  sx={{ minWidth: 140 }}
                >
                  {LANGUAGE_CHOICES.map((c) => (
                    <MenuItem key={c.id} value={c.id}>
                      {translate(c.name)}
                    </MenuItem>
                  ))}
                </MuiTextField>
                <MuiTextField
                  label={translate("padmakara.publications.publicationDate")}
                  type="date"
                  defaultValue={(defaultValues.publicationDate as string) || ""}
                  onChange={(e) =>
                    setDefaultValues((prev) => ({
                      ...prev,
                      publicationDate: e.target.value,
                    }))
                  }
                  slotProps={{ inputLabel: { shrink: true } }}
                  sx={{ minWidth: 170 }}
                />
                <MuiTextField
                  label={translate("padmakara.publications.version")}
                  defaultValue={(defaultValues.version as string) || ""}
                  onChange={(e) =>
                    setDefaultValues((prev) => ({
                      ...prev,
                      version: e.target.value,
                    }))
                  }
                  placeholder="v1.0"
                  helperText={translate("padmakara.publications.versionHelper")}
                  slotProps={{ inputLabel: { shrink: true } }}
                  sx={{ minWidth: 200 }}
                />
                <MuiTextField
                  label={translate("padmakara.publications.accessLevel")}
                  select
                  value={(defaultValues.accessLevel as string) || "public"}
                  onChange={(e) =>
                    setDefaultValues((prev) => ({
                      ...prev,
                      accessLevel: e.target.value,
                    }))
                  }
                  slotProps={{ inputLabel: { shrink: true } }}
                  sx={{ minWidth: 140 }}
                >
                  {ACCESS_LEVEL_CHOICES.map((c) => (
                    <MenuItem key={c.id} value={c.id}>
                      {translate(c.name)}
                    </MenuItem>
                  ))}
                </MuiTextField>
              </Box>

              {/* Save button */}
              <Box>
                <CreateSaveButton
                  defaultValues={defaultValues}
                  selectedAuthors={selectedAuthors}
                />
              </Box>
            </Box>
          </Box>
        </Box>
      </Create>
    );
  }

  // Phase: upload
  return (
    <Create>
      <Box sx={{ p: 4 }}>
        <Typography variant="h6" gutterBottom>
          {translate("padmakara.publications.newPublicationHeading")}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          {translate("padmakara.publications.uploadPrompt")}
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
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            handleFile(e.dataTransfer.files[0]);
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <CloudUploadIcon sx={{ fontSize: 48, color: "grey.500", mb: 1 }} />
          <Typography variant="body1" gutterBottom>
            {translate("padmakara.publications.dragDropPdf")}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {translate("padmakara.publications.pdfFilesOnly")}
          </Typography>
        </Box>
      </Box>
    </Create>
  );
};
