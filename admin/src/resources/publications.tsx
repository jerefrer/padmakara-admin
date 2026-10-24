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
  ListSubheader,
  MenuItem,
  TextField as MuiTextField,
  Typography,
} from "@mui/material";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
  ReferenceField,
  ReferenceInput,
  required,
  SaveButton,
  SelectInput,
  SimpleForm,
  TextField,
  TextInput,
  Toolbar,
  useDataProvider,
  useDelete,
  useEditContext,
  useLocaleState,
  useNotify,
  useRecordContext,
  useRedirect,
  useTranslate,
} from "react-admin";

/** Audience slugs for which the linked events decide who gets access. */
const EVENT_BASED_AUDIENCE_SLUGS = [
  "event-participants",
  "retreat-group-members",
  "received-initiation",
  "available-on-request-only",
];
const PUBLIC_AUDIENCE_SLUG = "free-anyone";

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

// ─── Audience + who gets access ──────────────────────────────────────────────

interface AudienceOption {
  id: number;
  slug: string;
  nameEn: string;
  namePt?: string | null;
}

interface EventOption {
  id: number;
  eventCode: string;
  titleEn?: string | null;
  titlePt?: string | null;
}

interface GroupOption {
  id: number;
  nameEn: string;
  namePt?: string | null;
}

interface UserOption {
  id: number;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

/** The audience-related values a publication form edits. */
interface AccessValues {
  audienceId: number | null | undefined;
  eventIds: number[];
  retreatGroupIds: number[];
  accessUserIds: number[];
  /** The users of the access list as the API described them, to label the chips. */
  accessUsers: UserOption[];
}

type AccessChange = Partial<Omit<AccessValues, "accessUsers">> & { accessUsers?: UserOption[] };

/** Shown in the app to the people who qualify; a ticked retreat group decides who. */
const GROUP_AUDIENCE_SLUGS = ["retreat-group-members", "event-participants"];
const SHOWN_AUDIENCE_SLUGS = ["free-anyone", "free-subscribers", ...GROUP_AUDIENCE_SLUGS];
/** Hidden in the app unless an admin adds the user to the access list. */
const HIDDEN_AUDIENCE_SLUGS = ["available-on-request-only", "received-initiation", "restricted"];
/** The audiences whose access used to come from the linked events. */
const LEGACY_EVENT_AUDIENCE_SLUGS = [...GROUP_AUDIENCE_SLUGS, "received-initiation", "available-on-request-only"];

function audienceName(a: AudienceOption, locale: string): string {
  return locale === "pt" && a.namePt ? a.namePt : a.nameEn;
}

function groupName(g: GroupOption, locale: string): string {
  return locale === "pt" && g.namePt ? g.namePt : g.nameEn;
}

function userLabel(u: UserOption): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return name ? `${name} (${u.email})` : u.email;
}

function eventLabel(e: EventOption, locale: string): string {
  const title = (locale === "pt" && e.titlePt ? e.titlePt : e.titleEn) ?? "";
  return title ? `${e.eventCode} — ${title}` : e.eventCode;
}

/** Retreat groups to tick, for the "retreat group members" and "event participants" audiences. */
function RetreatGroupsPicker({
  value,
  onChange,
  slug,
  locale,
  legacy,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
  slug: string;
  locale: string;
  /** Linked events still decide access, so no groups is not an error (see LegacyLinkedEvents). */
  legacy: boolean;
}) {
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const [options, setOptions] = useState<GroupOption[]>([]);

  useEffect(() => {
    dataProvider
      .getList<GroupOption>("groups", {
        pagination: { page: 1, perPage: 500 },
        sort: { field: "nameEn", order: "ASC" },
        filter: {},
      })
      .then(({ data }) => setOptions(data));
  }, [dataProvider]);

  const selected = value
    .map((id) => options.find((g) => g.id === id))
    .filter((g): g is GroupOption => !!g);
  const empty = value.length === 0 && !legacy;
  const helperKey =
    slug === "event-participants"
      ? "padmakara.publications.groupsHelperParticipants"
      : "padmakara.publications.groupsHelperMembers";

  return (
    <Autocomplete
      multiple
      options={options}
      getOptionLabel={(g) => groupName(g, locale)}
      value={selected}
      onChange={(_, v) => onChange(v.map((g) => g.id))}
      isOptionEqualToValue={(o, v) => o.id === v.id}
      renderInput={(params) => (
        <MuiTextField
          {...params}
          label={translate("padmakara.publications.retreatGroups")}
          placeholder={translate("padmakara.publications.retreatGroupsPlaceholder")}
          error={empty}
          helperText={translate(empty ? "padmakara.publications.retreatGroupsNeeded" : helperKey)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
      )}
    />
  );
}

/** The access list: users who see a hidden publication. Searched on the server. */
function AccessListPicker({
  value,
  known,
  onChange,
}: {
  value: number[];
  known: UserOption[];
  onChange: (users: UserOption[]) => void;
}) {
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const [input, setInput] = useState("");
  const [options, setOptions] = useState<UserOption[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      dataProvider
        .getList<UserOption>("users", {
          pagination: { page: 1, perPage: 20 },
          sort: { field: "email", order: "ASC" },
          filter: { q: input },
        })
        .then(({ data }) => setOptions(data));
    }, 250);
    return () => clearTimeout(timer);
  }, [dataProvider, input]);

  const selected = value.map((id) => known.find((u) => u.id === id) ?? { id, email: `#${id}` });

  return (
    <Autocomplete
      multiple
      // The server already filtered by what was typed.
      filterOptions={(o) => o}
      options={options}
      getOptionLabel={userLabel}
      value={selected}
      onChange={(_, v) => onChange(v)}
      onInputChange={(_, text, reason) => {
        if (reason === "input") setInput(text);
      }}
      isOptionEqualToValue={(o, v) => o.id === v.id}
      noOptionsText={translate("padmakara.publications.accessListNoUsers")}
      renderInput={(params) => (
        <MuiTextField
          {...params}
          label={translate("padmakara.publications.accessList")}
          placeholder={translate("padmakara.publications.accessListPlaceholder")}
          helperText={translate(
            value.length === 0
              ? "padmakara.publications.accessListEmpty"
              : "padmakara.publications.accessListHelper",
          )}
          slotProps={{ inputLabel: { shrink: true } }}
        />
      )}
    />
  );
}

/** Linked events of a publication that still relies on them, read-only. */
function LegacyLinkedEvents({ eventIds, locale }: { eventIds: number[]; locale: string }) {
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const [events, setEvents] = useState<EventOption[]>([]);

  useEffect(() => {
    dataProvider
      .getList<EventOption>("events", {
        pagination: { page: 1, perPage: 1000 },
        sort: { field: "startDate", order: "DESC" },
        filter: {},
      })
      .then(({ data }) => setEvents(data));
  }, [dataProvider]);

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {translate("padmakara.publications.legacyEventsNote")}
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {eventIds.map((id) => {
          const event = events.find((e) => e.id === id);
          return <Chip key={id} size="small" variant="outlined" label={event ? eventLabel(event, locale) : `#${id}`} />;
        })}
      </Box>
    </Box>
  );
}

/**
 * Audience select plus the one field that says who gets access for it:
 * retreat groups for the group and participant audiences, the access list for
 * the audiences hidden in the app, nothing for the open ones. Controlled, so
 * both the react-hook-form edit page and the state-driven create page can use
 * it.
 */
function AudienceAccessFields({
  values,
  onChange,
}: {
  values: AccessValues;
  onChange: (next: AccessChange) => void;
}) {
  const translate = useTranslate();
  const dataProvider = useDataProvider();
  const [locale] = useLocaleState();
  const [audienceOptions, setAudienceOptions] = useState<AudienceOption[]>([]);
  const { audienceId, eventIds, retreatGroupIds, accessUserIds, accessUsers } = values;

  useEffect(() => {
    dataProvider
      .getList<AudienceOption>("audiences", {
        pagination: { page: 1, perPage: 500 },
        sort: { field: "displayOrder", order: "ASC" },
        filter: {},
      })
      .then(({ data }) => setAudienceOptions(data));
  }, [dataProvider]);

  // A new publication starts public, as before.
  useEffect(() => {
    if (audienceId == null && audienceOptions.length > 0) {
      const open = audienceOptions.find((a) => a.slug === PUBLIC_AUDIENCE_SLUG);
      if (open) onChange({ audienceId: open.id });
    }
  }, [audienceId, audienceOptions, onChange]);

  const audience = audienceOptions.find((a) => a.id === audienceId) ?? null;
  const slug = audience?.slug;
  const groupBased = !!slug && GROUP_AUDIENCE_SLUGS.includes(slug);
  const hidden = !!slug && HIDDEN_AUDIENCE_SLUGS.includes(slug);
  // Classified before groups and the access list existed: the linked events still decide.
  const legacyEvents =
    !!slug &&
    LEGACY_EVENT_AUDIENCE_SLUGS.includes(slug) &&
    eventIds.length > 0 &&
    (groupBased ? retreatGroupIds.length === 0 : accessUserIds.length === 0);

  const inGroup = (group: string[]) => audienceOptions.filter((a) => group.includes(a.slug));
  const others = audienceOptions.filter(
    (a) => !SHOWN_AUDIENCE_SLUGS.includes(a.slug) && !HIDDEN_AUDIENCE_SLUGS.includes(a.slug),
  );
  const optionItem = (a: AudienceOption) => (
    <MenuItem key={a.id} value={a.id}>
      {audienceName(a, locale)}
    </MenuItem>
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, width: "100%" }}>
      <MuiTextField
        label={translate("padmakara.publications.audience")}
        select
        required
        value={audience ? audience.id : ""}
        onChange={(e) => onChange({ audienceId: Number(e.target.value) })}
        helperText={translate(
          hidden
            ? "padmakara.publications.audienceHelperHidden"
            : "padmakara.publications.audienceHelperShown",
        )}
        slotProps={{ inputLabel: { shrink: true } }}
        sx={{ minWidth: 260, maxWidth: 400 }}
      >
        <ListSubheader>{translate("padmakara.publications.audienceGroupShown")}</ListSubheader>
        {inGroup(SHOWN_AUDIENCE_SLUGS).map(optionItem)}
        <ListSubheader>{translate("padmakara.publications.audienceGroupHidden")}</ListSubheader>
        {inGroup(HIDDEN_AUDIENCE_SLUGS).map(optionItem)}
        {others.map(optionItem)}
      </MuiTextField>

      {groupBased && (
        <RetreatGroupsPicker
          value={retreatGroupIds}
          onChange={(ids) => onChange({ retreatGroupIds: ids })}
          slug={slug}
          locale={locale}
          legacy={legacyEvents}
        />
      )}
      {hidden && (
        <AccessListPicker
          value={accessUserIds}
          known={accessUsers}
          onChange={(users) =>
            onChange({ accessUserIds: users.map((u) => u.id), accessUsers: users })
          }
        />
      )}
      {legacyEvents && <LegacyLinkedEvents eventIds={eventIds} locale={locale} />}
    </Box>
  );
}

/** Chip with the locale-aware name of the audience in context. */
function AudienceChip() {
  const record = useRecordContext<AudienceOption>();
  const [locale] = useLocaleState();
  if (!record) return null;
  return <Chip label={audienceName(record, locale)} size="small" variant="outlined" />;
}

/** Edit-page wrapper: reads and writes the audience and its access fields on the form. */
function AudienceAccessInput() {
  const { watch, setValue } = useFormContext();
  const values: AccessValues = {
    audienceId: watch("audienceId") as number | null | undefined,
    eventIds: (watch("eventIds") as number[] | undefined) ?? [],
    retreatGroupIds: (watch("retreatGroupIds") as number[] | undefined) ?? [],
    accessUserIds: (watch("accessUserIds") as number[] | undefined) ?? [],
    accessUsers: (watch("accessUsers") as UserOption[] | undefined) ?? [],
  };
  const handleChange = useCallback(
    (next: AccessChange) => {
      for (const [key, value] of Object.entries(next)) {
        if (value !== undefined) setValue(key, value, { shouldDirty: true });
      }
    },
    [setValue],
  );
  return <AudienceAccessFields values={values} onChange={handleChange} />;
}

// ─── List ────────────────────────────────────────────────────────────────────

const publicationFilters = [
  <ReferenceInput
    key="audienceId"
    source="audienceId"
    reference="audiences"
    label="padmakara.publications.audience"
    alwaysOn
  >
    <SelectInput optionText="nameEn" />
  </ReferenceInput>,
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
          sortBy="authors"
          render={(record: { authors?: string[] }) =>
            (record?.authors || []).join(", ") || "\u2014"
          }
        />
        <ReferenceField
          source="audienceId"
          reference="audiences"
          label={translate("padmakara.publications.access")}
          link={false}
          sortBy="audienceName"
        >
          <AudienceChip />
        </ReferenceField>
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

/**
 * Mounts the form only once the record has been fetched from the API.
 *
 * react-admin first renders whatever it has cached for the record (a row from
 * the list, or the copy from an earlier visit) and refetches in the
 * background. The refetched record always differs (a fresh presigned cover
 * URL, linked ids), and the form resets whenever the record changes, so a
 * choice made in between, such as a new audience, silently reverted to the
 * saved value. Waiting for that fetch removes the window; once the form is
 * mounted it stays mounted.
 */
function WaitForFreshRecord({ children }: { children: ReactNode }) {
  const { isFetching } = useEditContext();
  const settled = useRef(false);
  if (!isFetching) settled.current = true;
  if (!settled.current) {
    return (
      <Box sx={{ p: 4, textAlign: "center" }}>
        <CircularProgress />
      </Box>
    );
  }
  return <>{children}</>;
}

export const PublicationEdit = () => {
  const translate = useTranslate();
  return (
    <Edit>
      <WaitForFreshRecord>
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
            </Box>

            <AudienceAccessInput />

            <Box sx={{ mt: 2, pt: 2, borderTop: "1px solid", borderColor: "divider" }}>
              <PdfReplaceSection />
            </Box>
          </Box>
        </Box>
      </SimpleForm>
      </WaitForFreshRecord>
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

  const handleAudienceChange = useCallback(
    (next: AccessChange) => setDefaultValues((prev) => ({ ...prev, ...next })),
    [],
  );

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
        eventIds: [],
        retreatGroupIds: [],
        accessUserIds: [],
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
              </Box>

              <AudienceAccessFields
                values={{
                  audienceId: defaultValues.audienceId as number | undefined,
                  eventIds: (defaultValues.eventIds as number[] | undefined) ?? [],
                  retreatGroupIds: (defaultValues.retreatGroupIds as number[] | undefined) ?? [],
                  accessUserIds: (defaultValues.accessUserIds as number[] | undefined) ?? [],
                  accessUsers: (defaultValues.accessUsers as UserOption[] | undefined) ?? [],
                }}
                onChange={handleAudienceChange}
              />

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
