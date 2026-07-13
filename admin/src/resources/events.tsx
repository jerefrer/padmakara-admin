import { useState, useCallback, useEffect, useRef } from "react";
import {
  List,
  Datagrid,
  TextField,
  DateField,
  EditButton,
  useDataProvider,
  useNotify,
  useRedirect,
  FunctionField,
  Title,
  useGetOne,
  useRefresh,
  useTranslate,
  useLocaleState,
  ReferenceField,
  ReferenceArrayField,
  SingleFieldList,
  ChipField,
  TextInput,
  ReferenceInput,
  AutocompleteInput,
  SelectInput,
  ReferenceArrayInput,
  AutocompleteArrayInput,
} from "react-admin";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import MuiTextField from "@mui/material/TextField";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Autocomplete from "@mui/material/Autocomplete";
import Grid from "@mui/material/Grid";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import LinearProgress from "@mui/material/LinearProgress";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import SaveIcon from "@mui/icons-material/Save";
import DeleteIcon from "@mui/icons-material/Delete";
import SpaIcon from "@mui/icons-material/SelfImprovement";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import { useParams } from "react-router-dom";

import { TrackDropZone } from "../components/TrackDropZone";
import { TrackAnalysisDropZone } from "../components/TrackAnalysisDropZone";
import { AnalysisReport } from "../components/AnalysisReport";
import { SessionPreview } from "../components/SessionPreview";
import { EventFilesPreview } from "../components/EventFilesPreview";
import { UploadProgress } from "../components/UploadProgress";
import { ReadAlongPanel } from "../components/ReadAlongPanel";
import { SubtitlePanel } from "../components/SubtitlePanel";
import { TranscriptDropZone, type TranscriptUploadState } from "../components/TranscriptDropZone";
import {
  SessionTrackTable,
  type TableValue,
  type TableTrack,
  type TrackCorrectionsMap,
  correctionFieldLabel,
  correctionKindLabel,
} from "../components/SessionTrackTable";
import { exportTracksToXlsx, type TrackExportRow } from "../utils/exportTracksXlsx";
import { validateImportEvent } from "../utils/eventValidation";
import {
  uploadTracks,
  uploadTranscript,
  type UploadItem,
  type UploadProgress as UploadProgressData,
} from "../utils/uploadManager";
import { uploadVideoFile } from "../utils/videoUploader";
import { authFetch } from "../utils/authFetch";
import { translateFields, type TranslateDirection } from "../utils/translateFields";
import {
  type ParsedTrack,
  type InferredSession,
  type SessionVideo,
  type FolderMetadata,
  inferSessions,
  parseTrackFile,
} from "../utils/trackParser";
import type { AnalysisResult, ScannedFile, TrackCorrection } from "../utils/analyzeFolder";

/** Convert a human-readable date ("April 17") or ISO date to YYYY-MM-DD using event year */
const MONTH_MAP: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

function toIsoDate(date: string | null, eventStartDate: string | null): string | null {
  if (!date) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const m1 = date.match(/^(\w+)\s+(\d{1,2})$/);
  const m2 = date.match(/^(\d{1,2})\s+(\w+)$/);
  const month = m1?.[1] || m2?.[2];
  const day = m1?.[2] || m2?.[1];
  if (!month || !day) return null;
  const mm = MONTH_MAP[month.toLowerCase()];
  if (!mm) return null;
  const year = eventStartDate?.slice(0, 4) || new Date().getFullYear().toString();
  return `${year}-${mm}-${day.padStart(2, "0")}`;
}

/** Get locale-aware name for bilingual entities */
function localeName(entity: { nameEn: string; namePt?: string | null }, locale: string): string {
  return locale === "pt" && entity.namePt ? entity.namePt : entity.nameEn;
}

/* ───────────── Event List ───────────── */

const StatusChip = ({ status }: { status: string }) => {
  const colorMap: Record<string, "success" | "warning" | "default"> = {
    published: "success",
    draft: "warning",
    archived: "default",
  };
  return (
    <Chip
      label={status}
      size="small"
      color={colorMap[status] ?? "default"}
      sx={{ fontWeight: 600, textTransform: "capitalize", color: "#fff" }}
    />
  );
};

/**
 * Fetch a resource list directly via the data provider and prepend a
 * synthetic "(None)" entry. We bypass react-admin's `useGetList` hook
 * because passing the resulting choices into AutocompleteArrayInput as
 * a prop (outside a ReferenceInput context) wasn't surfacing the label
 * fields correctly. Going through dataProvider.getList gives us the
 * raw payload — the same shape <ReferenceArrayInput> sees — and lets
 * us pre-compute a `__label` field that a function-based optionText
 * reads unconditionally.
 */
function useChoicesWithNone(
  resource: string,
  labelField: string,
): { id: any; __label: string }[] {
  const dataProvider = useDataProvider();
  const [choices, setChoices] = useState<{ id: any; __label: string }[]>([
    { id: "none", __label: "(None)" },
  ]);

  useEffect(() => {
    let cancelled = false;
    dataProvider
      .getList(resource, {
        pagination: { page: 1, perPage: 1000 },
        sort: { field: "id", order: "ASC" },
        filter: {},
      })
      .then((res) => {
        if (cancelled) return;
        const labelOf = (d: any): string =>
          d?.[labelField] ?? d?.nameEn ?? d?.name ?? d?.titleEn ?? `#${d?.id}`;
        setChoices([
          { id: "none", __label: "(None)" },
          ...(res.data ?? []).map((d: any) => ({ ...d, __label: labelOf(d) })),
        ]);
      })
      .catch((err: unknown) => {
        // Keep the fallback "(None)"-only list visible; surface the failure
        // in the console so devs can diagnose, but don't crash the form.
        // eslint-disable-next-line no-console
        console.error(`useChoicesWithNone(${resource}) failed:`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [dataProvider, resource, labelField]);

  return choices;
}

// IMPORTANT — The reference resource is named `referenceResource`, not
// `resource`. React-Admin's <FilterFormInput> calls
// React.cloneElement(filter, { resource: <listResource> }) which silently
// overrides any `resource` prop we set, so the audiences/event-types/etc.
// filter would re-fetch from the events resource. Naming the prop
// differently sidesteps the clone.
const ArrayFilterWithNone = ({
  source,
  referenceResource,
  label,
  optionText,
  ...rest
}: {
  source: string;
  referenceResource: string;
  label: string;
  optionText: string;
  [k: string]: any;
}) => {
  const choices = useChoicesWithNone(referenceResource, optionText);
  return (
    <AutocompleteArrayInput
      {...rest}
      source={source}
      label={label}
      choices={choices}
      optionText={(r: any) => r.__label}
      optionValue="id"
    />
  );
};

const SingleFilterWithNone = ({
  source,
  referenceResource,
  label,
  optionText,
  ...rest
}: {
  source: string;
  referenceResource: string;
  label: string;
  optionText: string;
  [k: string]: any;
}) => {
  const choices = useChoicesWithNone(referenceResource, optionText);
  return (
    <SelectInput
      {...rest}
      source={source}
      label={label}
      choices={choices}
      optionText={(r: any) => r.__label}
      optionValue="id"
    />
  );
};

const eventFilters = [
  <TextInput key="q" label="Search" source="q" alwaysOn />,
  <SingleFilterWithNone
    key="eventType"
    source="eventTypeId"
    referenceResource="event-types"
    label="Event Type"
    optionText="nameEn"
  />,
  <ArrayFilterWithNone
    key="groups"
    source="groupIds"
    referenceResource="groups"
    label="Retreat Groups"
    optionText="nameEn"
  />,
  <ArrayFilterWithNone
    key="teachers"
    source="teacherIds"
    referenceResource="teachers"
    label="Teachers"
    optionText="name"
  />,
  <ArrayFilterWithNone
    key="audiences"
    source="audienceIds"
    referenceResource="audiences"
    label="Audiences"
    optionText="nameEn"
  />,
  <SelectInput
    key="status"
    source="status"
    label="Status"
    choices={[
      { id: "draft", name: "Draft" },
      { id: "published", name: "Published" },
      { id: "archived", name: "Archived" },
    ]}
  />,
];

const FeaturedToggleCell = ({ record }: { record: any }) => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();
  const [loading, setLoading] = useState(false);

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setLoading(true);
    const newFeaturedAt = record.featuredAt ? null : new Date().toISOString();
    try {
      await dataProvider.update("events", {
        id: record.id,
        data: { featuredAt: newFeaturedAt },
        previousData: record,
      });
      notify(newFeaturedAt ? "Event set as featured" : "Featured removed", { type: "success" });
      refresh();
    } catch (error: any) {
      notify(`Error: ${error.message}`, { type: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Tooltip title={record.featuredAt ? "Remove from featured" : "Set as featured"}>
      <IconButton
        size="small"
        onClick={handleToggle}
        disabled={loading}
        sx={{ color: record.featuredAt ? "#f59e0b" : "action.disabled" }}
      >
        {record.featuredAt ? <StarIcon sx={{ fontSize: 20 }} /> : <StarBorderIcon sx={{ fontSize: 20 }} />}
      </IconButton>
    </Tooltip>
  );
};

export const EventList = () => {
  const translate = useTranslate();
  const [locale] = useLocaleState();
  return (
    <List
      filters={eventFilters}
      sort={{ field: "startDate", order: "DESC" }}
      perPage={50}
      sx={{
        "& .RaList-main": { maxWidth: "100%" },
        "& .RaList-content": { mt: 2 },
        // The "remove filter" minus button is aligned to the whole filter
        // wrapper, which reserves vertical space above the input for the
        // floating MUI label. That makes the button look slightly too high
        // relative to the visible input border. Nudge it down to sit
        // optically centered against the input's border box.
        "& .RaFilterFormInput-hideButton": {
          position: "relative",
          top: "4px",
        },
      }}
    >
      <Datagrid
        rowClick="edit"
        bulkActionButtons={false}
        sx={{ "& .RaDatagrid-row": { "&:hover": { backgroundColor: "rgba(91,94,166,0.03)" } } }}
      >
        <FunctionField
          label=""
          sortBy="featuredAt"
          render={(record: any) => <FeaturedToggleCell record={record} />}
        />
        <FunctionField
          label={translate("padmakara.events.title")}
          render={(record: any) => (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
              <Typography variant="caption" sx={{ fontFamily: "monospace", fontSize: "0.7rem", opacity: 0.6, fontWeight: 500 }}>
                {record.eventCode}
              </Typography>
              <Typography variant="body2" sx={{ fontSize: "0.875rem" }}>
                {record.titleEn}
              </Typography>
            </Box>
          )}
        />

        <FunctionField
          label="Event Type"
          sortBy="eventTypeId"
          render={(record: any) => (
            record.eventType ? <Chip label={record.eventType.nameEn} size="small" /> : "—"
          )}
        />

        <ReferenceArrayField source="groupIds" reference="groups" label="Retreat Groups" sortable={false}>
          <SingleFieldList>
            <ChipField source="abbreviation" size="small" />
          </SingleFieldList>
        </ReferenceArrayField>

        <ReferenceArrayField source="teacherIds" reference="teachers" label="Teachers" sortable={false}>
          <SingleFieldList>
            <ChipField source="abbreviation" size="small" />
          </SingleFieldList>
        </ReferenceArrayField>

        <ReferenceArrayField source="audienceIds" reference="audiences" label="Audience" sortable={false}>
          <SingleFieldList>
            <ChipField source="nameEn" size="small" />
          </SingleFieldList>
        </ReferenceArrayField>

        <FunctionField
          label={translate("padmakara.events.dates")}
          sortBy="startDate"
          sx={{ whiteSpace: "nowrap" }}
          render={(record: any) => {
            if (!record.startDate) return "—";
            const dateLocale = locale === "pt" ? "pt-PT" : "en-GB";
            const startDate = new Date(record.startDate);
            const endDate = record.endDate ? new Date(record.endDate) : null;

            // If same date or no end date, show single date
            if (!endDate || record.startDate === record.endDate) {
              const formatted = startDate.toLocaleDateString(dateLocale, {
                day: "numeric",
                month: "long",
                year: "numeric"
              });
              return (
                <Box sx={{ textAlign: "right", fontSize: "0.875rem" }}>
                  {formatted}
                </Box>
              );
            }

            // Different dates - show from/to on separate lines
            const startFormatted = startDate.toLocaleDateString(dateLocale, {
              day: "numeric",
              month: "long",
              year: "numeric"
            });
            const endFormatted = endDate.toLocaleDateString(dateLocale, {
              day: "numeric",
              month: "long",
              year: "numeric"
            });

            return (
              <Box sx={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 0.5, columnGap: 1 }}>
                <Box component="span" sx={{ opacity: 0.6, fontSize: "0.875rem", textAlign: "right" }}>
                  {translate("padmakara.events.from")}:
                </Box>
                <Box component="span" sx={{ fontSize: "0.875rem", textAlign: "right" }}>
                  {startFormatted}
                </Box>
                <Box component="span" sx={{ opacity: 0.6, fontSize: "0.875rem", textAlign: "right" }}>
                  {translate("padmakara.events.to")}:
                </Box>
                <Box component="span" sx={{ fontSize: "0.875rem", textAlign: "right" }}>
                  {endFormatted}
                </Box>
              </Box>
            );
          }}
        />
        <FunctionField label={translate("padmakara.events.status")} render={(record: any) => <StatusChip status={record.status} />} />
        <EditButton />
      </Datagrid>
    </List>
  );
};

/* ───────────── Shared types & constants ───────────── */

export interface EventFormData {
  eventCode: string;
  titleEn: string;
  titlePt: string;
  mainThemesPt: string;
  mainThemesEn: string;
  sessionThemesEn: string;
  sessionThemesPt: string;
  titleEnReviewed: boolean;
  titlePtReviewed: boolean;
  mainThemesEnReviewed: boolean;
  mainThemesPtReviewed: boolean;
  sessionThemesEnReviewed: boolean;
  sessionThemesPtReviewed: boolean;
  startDate: string;
  endDate: string;
  status: string;
  featuredAt: string | null;
}

export interface TeacherOption { id: number; name: string; abbreviation: string }
export interface PlaceOption { id: number; name: string; abbreviation: string | null }
export interface GroupOption { id: number; nameEn: string; namePt: string | null; abbreviation: string | null; slug: string }
export interface EventTypeOption { id: number; nameEn: string; namePt: string | null; abbreviation: string; slug: string }
export interface AudienceOption { id: number; nameEn: string; namePt: string | null; slug: string }

export const EMPTY_FORM: EventFormData = {
  eventCode: "", titleEn: "", titlePt: "",
  mainThemesPt: "", mainThemesEn: "",
  sessionThemesEn: "", sessionThemesPt: "",
  titleEnReviewed: true, titlePtReviewed: true,
  mainThemesEnReviewed: true, mainThemesPtReviewed: true,
  sessionThemesEnReviewed: true, sessionThemesPtReviewed: true,
  startDate: "", endDate: "", status: "draft",
  featuredAt: null,
};

/* ───────────── Shared form fields ───────────── */

interface EventFormProps {
  form: EventFormData;
  setForm: React.Dispatch<React.SetStateAction<EventFormData>>;
  selectedTeachers: TeacherOption[];
  setSelectedTeachers: React.Dispatch<React.SetStateAction<TeacherOption[]>>;
  selectedPlaces: PlaceOption[];
  setSelectedPlaces: React.Dispatch<React.SetStateAction<PlaceOption[]>>;
  selectedGroups: GroupOption[];
  setSelectedGroups: React.Dispatch<React.SetStateAction<GroupOption[]>>;
  selectedEventType: EventTypeOption | null;
  setSelectedEventType: React.Dispatch<React.SetStateAction<EventTypeOption | null>>;
  selectedAudience: AudienceOption | null;
  setSelectedAudience: React.Dispatch<React.SetStateAction<AudienceOption | null>>;
  allTeachers: TeacherOption[];
  allPlaces: PlaceOption[];
  allGroups: GroupOption[];
  allEventTypes: EventTypeOption[];
  allAudiences: AudienceOption[];
  sessions: InferredSession[];
  transcripts: any[];
  eventFiles: any[];
  onSessionTitleChange: (idx: number, title: string) => void;
  onTrackUpdate?: (trackId: number, updates: Partial<ParsedTrack>) => Promise<void>;
  onTrackDelete?: (trackId: number) => Promise<void>;
  onSessionVideoUpload?: (sessionId: number, file: File) => void;
  /** Deletes one attached video by its session_videos row id. */
  onSessionVideoDelete?: (sessionVideoId: number) => Promise<void>;
  onFeaturedToggle?: () => void;
  onStatusChange?: (newStatus: string) => void;
  trackCount: number;
  transcriptCount: number;
  /** When true the event-code field is read-only (the legacy-import screen,
   *  where the code is the job identity and must not change). */
  readOnlyEventCode?: boolean;
}

const syncedRows = (a: string, b: string, min = 3) =>
  Math.max(a.split("\n").length, b.split("\n").length, min);

/** Text fields that have a companion `<field>Reviewed` boolean. Editing one of
 *  these by hand marks it reviewed; translating INTO one marks it unreviewed. */
const REVIEWED_KEY: Partial<Record<keyof EventFormData, keyof EventFormData>> = {
  titleEn: "titleEnReviewed",
  titlePt: "titlePtReviewed",
  mainThemesEn: "mainThemesEnReviewed",
  mainThemesPt: "mainThemesPtReviewed",
  sessionThemesEn: "sessionThemesEnReviewed",
  sessionThemesPt: "sessionThemesPtReviewed",
};

const EVENT_TYPE_COLORS = [
  "#5B5EA6", "#E57373", "#4DB6AC", "#FFB74D", "#7986CB",
  "#A1887F", "#4DD0E1", "#AED581", "#F06292", "#BA68C8",
  "#FF8A65", "#81C784", "#64B5F6", "#DCE775",
];

const AUDIENCE_COLORS = [
  "#26A69A", "#5C6BC0", "#EF5350", "#FFA726", "#AB47BC", "#66BB6A",
  "#42A5F5", "#EC407A", "#8D6E63", "#78909C",
];

function pickColor(id: number, palette: string[]): string {
  return palette[(id - 1) % palette.length]!;
}

const ColorDot = ({ color, size = 12 }: { color: string; size?: number }) => (
  <Box
    component="span"
    sx={{
      width: size,
      height: size,
      borderRadius: "50%",
      bgcolor: color,
      display: "inline-block",
      flexShrink: 0,
    }}
  />
);

const isParallelRetreats = (et: EventTypeOption | null) =>
  et?.abbreviation === "RET";

export const EventFormFields = ({
  form, setForm,
  selectedTeachers, setSelectedTeachers,
  selectedPlaces, setSelectedPlaces,
  selectedGroups, setSelectedGroups,
  selectedEventType, setSelectedEventType,
  selectedAudience, setSelectedAudience,
  allTeachers, allPlaces, allGroups, allEventTypes, allAudiences,
  sessions, transcripts, eventFiles, onSessionTitleChange, onTrackUpdate, onTrackDelete,
  onSessionVideoUpload, onSessionVideoDelete,
  onFeaturedToggle, onStatusChange, trackCount, transcriptCount,
  readOnlyEventCode,
}: EventFormProps) => {
  const translate = useTranslate();
  const [locale] = useLocaleState();

  const updateField =
    (field: keyof EventFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      const reviewedKey = REVIEWED_KEY[field];
      setForm((prev) => ({
        ...prev,
        [field]: value,
        ...(reviewedKey ? { [reviewedKey]: true } : {}),
      }));
    };

  const notify = useNotify();
  // Which field (or "all") is currently being translated — drives spinners/disabled.
  const [translating, setTranslating] = useState<string | null>(null);

  const translateOne = async (
    sourceField: keyof EventFormData,
    targetField: keyof EventFormData,
    targetReviewedField: keyof EventFormData,
    direction: TranslateDirection,
  ) => {
    const source = String(form[sourceField] ?? "").trim();
    if (!source) return;
    setTranslating(sourceField as string);
    try {
      const out = await translateFields(direction, { [targetField as string]: source });
      const translated = out[targetField as string] ?? "";
      setForm((prev) => ({ ...prev, [targetField]: translated, [targetReviewedField]: false }));
    } catch (e: any) {
      notify(`${translate("padmakara.events.translateError")}${e?.message ? `: ${e.message}` : ""}`, {
        type: "error",
      });
    } finally {
      setTranslating(null);
    }
  };

  const translateAllMissing = async (direction: TranslateDirection) => {
    // [sourceField, targetField, targetReviewedField]
    const pairs: Array<[keyof EventFormData, keyof EventFormData, keyof EventFormData]> =
      direction === "en-to-pt"
        ? [
            ["titleEn", "titlePt", "titlePtReviewed"],
            ["mainThemesEn", "mainThemesPt", "mainThemesPtReviewed"],
            ["sessionThemesEn", "sessionThemesPt", "sessionThemesPtReviewed"],
          ]
        : [
            ["titlePt", "titleEn", "titleEnReviewed"],
            ["mainThemesPt", "mainThemesEn", "mainThemesEnReviewed"],
            ["sessionThemesPt", "sessionThemesEn", "sessionThemesEnReviewed"],
          ];
    const items: Record<string, string> = {};
    const targetOf: Record<string, keyof EventFormData> = {};
    const reviewedOf: Record<string, keyof EventFormData> = {};
    for (const [src, tgt, rev] of pairs) {
      const source = String(form[src] ?? "").trim();
      const target = String(form[tgt] ?? "").trim();
      if (source && !target) {
        const k = tgt as string;
        items[k] = source;
        targetOf[k] = tgt;
        reviewedOf[k] = rev;
      }
    }
    if (Object.keys(items).length === 0) {
      notify(translate("padmakara.events.translateNothing"), { type: "info" });
      return;
    }
    setTranslating("all");
    try {
      const out = await translateFields(direction, items);
      setForm((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(out)) {
          (next as any)[targetOf[key]] = out[key];
          (next as any)[reviewedOf[key]] = false;
        }
        return next;
      });
    } catch (e: any) {
      notify(`${translate("padmakara.events.translateError")}${e?.message ? `: ${e.message}` : ""}`, {
        type: "error",
      });
    } finally {
      setTranslating(null);
    }
  };

  // Render the translate button + unreviewed chip that sit under one field.
  // `direction` translates THIS field into the OTHER field.
  const fieldControls = (
    thisField: keyof EventFormData,
    otherField: keyof EventFormData,
    otherReviewedField: keyof EventFormData,
    thisReviewedField: keyof EventFormData,
    direction: TranslateDirection,
    translateLabelKey: string,
  ) => (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.5, minHeight: 30 }}>
      <Button
        size="small"
        variant="text"
        disabled={!String(form[thisField] ?? "").trim() || translating !== null}
        startIcon={translating === (thisField as string) ? <CircularProgress size={14} /> : undefined}
        onClick={() => translateOne(thisField, otherField, otherReviewedField, direction)}
      >
        {translate(translateLabelKey)}
      </Button>
      {!form[thisReviewedField] && (
        <>
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label={translate("padmakara.events.aiUnreviewed")}
          />
          <Button
            size="small"
            variant="text"
            onClick={() => setForm((prev) => ({ ...prev, [thisReviewedField]: true }))}
          >
            {translate("padmakara.events.markReviewed")}
          </Button>
        </>
      )}
    </Box>
  );

  const handleEventTypeChange = useCallback(
    (v: EventTypeOption | null) => {
      setSelectedEventType(v);
      if (isParallelRetreats(v)) {
        const retreatGroupMembers = allAudiences.find((a) => a.nameEn === "Retreat group members");
        if (retreatGroupMembers) setSelectedAudience(retreatGroupMembers);
      } else {
        setSelectedGroups([]);
      }
    },
    [allAudiences, setSelectedEventType, setSelectedAudience, setSelectedGroups],
  );

  const showGroups = isParallelRetreats(selectedEventType);
  const audienceFrozen = isParallelRetreats(selectedEventType);

  return (
    <>
      {/* ── Section 1: Event Details ── */}
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 2, mt: 1 }}>
        <Box sx={{ flex: 1 }}>
          <SectionHeader number={1} title={translate("padmakara.events.details")} subtitle={translate("padmakara.events.reviewComplete")} />
        </Box>
        <ToggleButtonGroup
          value={form.status}
          exclusive
          onChange={(_, val) => { if (val) { setForm((prev) => ({ ...prev, status: val })); onStatusChange?.(val); } }}
          size="small"
          sx={{ flexShrink: 0 }}
        >
          <ToggleButton
            value="draft"
            sx={{
              px: 2, fontWeight: 600, textTransform: "capitalize",
              "&.Mui-selected": { bgcolor: "warning.light", color: "warning.contrastText", "&:hover": { bgcolor: "warning.main" } },
            }}
          >
            {translate("padmakara.events.draft")}
          </ToggleButton>
          <ToggleButton
            value="published"
            sx={{
              px: 2, fontWeight: 600, textTransform: "capitalize",
              "&.Mui-selected": { bgcolor: "success.light", color: "success.contrastText", "&:hover": { bgcolor: "success.main" } },
            }}
          >
            {translate("padmakara.events.published")}
          </ToggleButton>
        </ToggleButtonGroup>
        <Tooltip title={form.featuredAt ? "Remove from featured" : "Set as featured on home screen"}>
          <IconButton
            onClick={() => {
              setForm((prev) => ({
                ...prev,
                featuredAt: prev.featuredAt ? null : new Date().toISOString(),
              }));
              onFeaturedToggle?.();
            }}
            sx={{
              ml: 1,
              color: form.featuredAt ? "#f59e0b" : "action.disabled",
            }}
          >
            {form.featuredAt ? <StarIcon /> : <StarBorderIcon />}
          </IconButton>
        </Tooltip>
      </Box>

      {/* ── Title ── */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Box sx={{ display: "flex", gap: 1, mb: 2 }}>
          <Button size="small" variant="outlined" disabled={translating !== null}
            onClick={() => translateAllMissing("en-to-pt")}>
            {translate("padmakara.events.translateAllToPt")}
          </Button>
          <Button size="small" variant="outlined" disabled={translating !== null}
            onClick={() => translateAllMissing("pt-to-en")}>
            {translate("padmakara.events.translateAllToEn")}
          </Button>
        </Box>
        <Grid container spacing={2.5}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <MuiTextField
              label={translate("padmakara.events.titleEn")}
              value={form.titleEn}
              onChange={updateField("titleEn")}
              required
              fullWidth
              placeholder="2025 Spring Retreat"
              slotProps={{ inputLabel: { shrink: true } }}
            />
            {fieldControls("titleEn", "titlePt", "titlePtReviewed", "titleEnReviewed", "en-to-pt", "padmakara.events.translateToPt")}
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <MuiTextField
              label={translate("padmakara.events.titlePt")}
              value={form.titlePt}
              onChange={updateField("titlePt")}
              fullWidth
              placeholder="Retiro de Primavera 2025"
              slotProps={{ inputLabel: { shrink: true } }}
            />
            {fieldControls("titlePt", "titleEn", "titleEnReviewed", "titlePtReviewed", "pt-to-en", "padmakara.events.translateToEn")}
          </Grid>
        </Grid>
      </Paper>

      {/* ── Event Type, Audience & Retreat Groups ── */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Autocomplete
              options={allEventTypes}
              getOptionLabel={(o) => `${localeName(o, locale)} (${o.abbreviation})`}
              value={selectedEventType}
              onChange={(_, v) => handleEventTypeChange(v)}
              isOptionEqualToValue={(o, v) => o.id === v.id}
              renderOption={(props, option) => {
                const color = pickColor(option.id, EVENT_TYPE_COLORS);
                return (
                  <li {...props} key={option.id}>
                    <ColorDot color={color} />
                    <Box component="span" sx={{ ml: 1 }}>
                      {localeName(option, locale)} ({option.abbreviation})
                    </Box>
                  </li>
                );
              }}
              renderInput={(params) => (
                <MuiTextField
                  {...params}
                  label={translate("padmakara.events.eventType")}
                  placeholder={translate("padmakara.events.eventTypePlaceholder")}
                  slotProps={{ inputLabel: { shrink: true } }}
                  InputProps={{
                    ...params.InputProps,
                    startAdornment: (
                      <>
                        {selectedEventType && (
                          <Box sx={{ display: "flex", alignItems: "center", ml: 0.5, mr: -0.5 }}>
                            <ColorDot color={pickColor(selectedEventType.id, EVENT_TYPE_COLORS)} />
                          </Box>
                        )}
                        {params.InputProps.startAdornment}
                      </>
                    ),
                  }}
                />
              )}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <Autocomplete
              options={allAudiences}
              getOptionLabel={(o) => localeName(o, locale)}
              value={selectedAudience}
              onChange={(_, v) => { if (!audienceFrozen) setSelectedAudience(v); }}
              disabled={audienceFrozen}
              isOptionEqualToValue={(o, v) => o.id === v.id}
              renderOption={(props, option) => {
                const color = pickColor(option.id, AUDIENCE_COLORS);
                return (
                  <li {...props} key={option.id}>
                    <ColorDot color={color} />
                    <Box component="span" sx={{ ml: 1 }}>
                      {localeName(option, locale)}
                    </Box>
                  </li>
                );
              }}
              renderInput={(params) => (
                <MuiTextField
                  {...params}
                  label={translate("padmakara.events.audience")}
                  placeholder={translate("padmakara.events.audiencePlaceholder")}
                  slotProps={{ inputLabel: { shrink: true } }}
                  helperText={audienceFrozen ? translate("padmakara.events.audienceFrozenHint") : undefined}
                  InputProps={{
                    ...params.InputProps,
                    startAdornment: (
                      <>
                        {selectedAudience && (
                          <Box sx={{ display: "flex", alignItems: "center", ml: 0.5, mr: -0.5 }}>
                            <ColorDot color={pickColor(selectedAudience.id, AUDIENCE_COLORS)} />
                          </Box>
                        )}
                        {params.InputProps.startAdornment}
                      </>
                    ),
                  }}
                />
              )}
            />
          </Grid>
          {showGroups && (
            <Grid size={{ xs: 12 }}>
              <Autocomplete
                multiple
                options={allGroups}
                getOptionLabel={(o) => o.abbreviation ? `${localeName(o, locale)} (${o.abbreviation})` : localeName(o, locale)}
                value={selectedGroups}
                onChange={(_, v) => setSelectedGroups(v)}
                isOptionEqualToValue={(o, v) => o.id === v.id}
                renderInput={(params) => (
                  <MuiTextField {...params} label={translate("padmakara.events.retreatGroups")} placeholder={translate("padmakara.events.retreatGroupsPlaceholder")} slotProps={{ inputLabel: { shrink: true } }} />
                )}
              />
            </Grid>
          )}
        </Grid>
      </Paper>

      {/* ── Dates ── */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <MuiTextField
              label={translate("padmakara.events.startDate")}
              type="date"
              value={form.startDate}
              onChange={updateField("startDate")}
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <MuiTextField
              label={translate("padmakara.events.endDate")}
              type="date"
              value={form.endDate}
              onChange={updateField("endDate")}
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
          </Grid>
        </Grid>
      </Paper>

      {/* ── Teachers & Places ── */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid size={{ xs: 12 }}>
            <Autocomplete
              multiple
              options={allTeachers}
              getOptionLabel={(o) => `${o.name} (${o.abbreviation})`}
              value={selectedTeachers}
              onChange={(_, v) => setSelectedTeachers(v)}
              isOptionEqualToValue={(o, v) => o.id === v.id}
              renderInput={(params) => (
                <MuiTextField {...params} label={translate("padmakara.events.teachers")} placeholder={translate("padmakara.events.teachersPlaceholder")} slotProps={{ inputLabel: { shrink: true } }} />
              )}
            />
          </Grid>
          <Grid size={{ xs: 12 }}>
            <Autocomplete
              multiple
              options={allPlaces}
              getOptionLabel={(o) => o.abbreviation ? `${o.name} (${o.abbreviation})` : o.name}
              value={selectedPlaces}
              onChange={(_, v) => setSelectedPlaces(v)}
              isOptionEqualToValue={(o, v) => o.id === v.id}
              renderInput={(params) => (
                <MuiTextField {...params} label={translate("padmakara.events.places")} placeholder={translate("padmakara.events.placesPlaceholder")} slotProps={{ inputLabel: { shrink: true } }} />
              )}
            />
          </Grid>
        </Grid>
      </Paper>

      {/* ── Themes ── */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid size={{ xs: 12, sm: 6 }}>
            <MuiTextField
              label={translate("padmakara.events.mainThemesEn")}
              value={form.mainThemesEn}
              onChange={updateField("mainThemesEn")}
              fullWidth
              multiline
              minRows={syncedRows(form.mainThemesEn, form.mainThemesPt)}
              placeholder={translate("padmakara.events.mainThemesPlaceholderEn")}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            {fieldControls("mainThemesEn", "mainThemesPt", "mainThemesPtReviewed", "mainThemesEnReviewed", "en-to-pt", "padmakara.events.translateToPt")}
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <MuiTextField
              label={translate("padmakara.events.mainThemesPt")}
              value={form.mainThemesPt}
              onChange={updateField("mainThemesPt")}
              fullWidth
              multiline
              minRows={syncedRows(form.mainThemesEn, form.mainThemesPt)}
              placeholder={translate("padmakara.events.mainThemesPlaceholderPt")}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            {fieldControls("mainThemesPt", "mainThemesEn", "mainThemesEnReviewed", "mainThemesPtReviewed", "pt-to-en", "padmakara.events.translateToEn")}
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <MuiTextField
              label={translate("padmakara.events.sessionThemesEn")}
              value={form.sessionThemesEn}
              onChange={updateField("sessionThemesEn")}
              fullWidth
              multiline
              minRows={syncedRows(form.sessionThemesEn, form.sessionThemesPt)}
              placeholder={translate("padmakara.events.sessionThemesPlaceholderEn")}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            {fieldControls("sessionThemesEn", "sessionThemesPt", "sessionThemesPtReviewed", "sessionThemesEnReviewed", "en-to-pt", "padmakara.events.translateToPt")}
          </Grid>
          <Grid size={{ xs: 12, sm: 6 }}>
            <MuiTextField
              label={translate("padmakara.events.sessionThemesPt")}
              value={form.sessionThemesPt}
              onChange={updateField("sessionThemesPt")}
              fullWidth
              multiline
              minRows={syncedRows(form.sessionThemesEn, form.sessionThemesPt)}
              placeholder={translate("padmakara.events.sessionThemesPlaceholderPt")}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            {fieldControls("sessionThemesPt", "sessionThemesEn", "sessionThemesEnReviewed", "sessionThemesPtReviewed", "pt-to-en", "padmakara.events.translateToEn")}
          </Grid>
        </Grid>
      </Paper>

      {/* ── Event Code ── */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <MuiTextField
          label={translate("padmakara.events.eventCode")}
          value={form.eventCode}
          onChange={updateField("eventCode")}
          required
          fullWidth
          helperText={translate("padmakara.events.eventCodeHelper")}
          slotProps={{
            inputLabel: { shrink: true },
            htmlInput: { readOnly: readOnlyEventCode },
          }}
          sx={{ "& input": { fontFamily: "monospace", fontWeight: 600, letterSpacing: "0.02em" } }}
        />
      </Paper>

      {/* ── Section 2: Content ── */}
      {(sessions.length > 0 || transcripts.length > 0 || eventFiles.length > 0) && (
        <>
          <SectionHeader
            number={2}
            title={translate("padmakara.events.files")}
            subtitle={translate("padmakara.events.filesSubtitle")}
            chips={
              <>
                {sessions.length > 0 && (
                  <Chip label={`${sessions.length} ${translate("padmakara.events.sessions", { smart_count: sessions.length })}`} size="small" color="primary" variant="outlined" />
                )}
                {trackCount > 0 && (
                  <Chip label={`${trackCount} ${translate("padmakara.events.tracks", { smart_count: trackCount })}`} size="small" variant="outlined" />
                )}
                {transcriptCount > 0 && (
                  <Chip label={`${transcriptCount} ${translate("padmakara.events.transcripts", { smart_count: transcriptCount })}`} size="small" color="secondary" variant="outlined" />
                )}
              </>
            }
          />

          {/* Sessions (with their session-level tracks) */}
          {sessions.length > 0 && (
            <Box sx={{ mb: 3 }}>
              <SessionPreview
                sessions={sessions}
                onSessionTitleChange={onSessionTitleChange}
                onTrackUpdate={onTrackUpdate}
                onTrackDelete={onTrackDelete}
                onSessionVideoUpload={onSessionVideoUpload}
                onSessionVideoDelete={onSessionVideoDelete}
                allTeachers={allTeachers}
              />
            </Box>
          )}

          {/* Event-level files (transcripts, videos, etc.) */}
          {(transcripts.length > 0 || eventFiles.length > 0) && (
            <EventFilesPreview transcripts={transcripts} eventFiles={eventFiles} />
          )}
        </>
      )}
    </>
  );
};

/* ───────────── Shared hooks ───────────── */

export function useLookups(dataProvider: ReturnType<typeof useDataProvider>) {
  const [allTeachers, setAllTeachers] = useState<TeacherOption[]>([]);
  const [allPlaces, setAllPlaces] = useState<PlaceOption[]>([]);
  const [allGroups, setAllGroups] = useState<GroupOption[]>([]);
  const [allEventTypes, setAllEventTypes] = useState<EventTypeOption[]>([]);
  const [allAudiences, setAllAudiences] = useState<AudienceOption[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const fetch = async () => {
      try {
        const [t, p, g, et, au] = await Promise.all([
          dataProvider.getList<TeacherOption>("teachers", {
            pagination: { page: 1, perPage: 500 },
            sort: { field: "name", order: "ASC" },
            filter: {},
          }),
          dataProvider.getList<PlaceOption>("places", {
            pagination: { page: 1, perPage: 500 },
            sort: { field: "name", order: "ASC" },
            filter: {},
          }),
          dataProvider.getList<GroupOption>("groups", {
            pagination: { page: 1, perPage: 500 },
            sort: { field: "nameEn", order: "ASC" },
            filter: {},
          }),
          dataProvider.getList<EventTypeOption>("event-types", {
            pagination: { page: 1, perPage: 500 },
            sort: { field: "displayOrder", order: "ASC" },
            filter: {},
          }),
          dataProvider.getList<AudienceOption>("audiences", {
            pagination: { page: 1, perPage: 500 },
            sort: { field: "displayOrder", order: "ASC" },
            filter: {},
          }),
        ]);
        setAllTeachers(t.data);
        setAllPlaces(p.data);
        setAllGroups(g.data);
        setAllEventTypes(et.data);
        setAllAudiences(au.data);
      } catch {
        // Silently fail — lists still available when API connects
      } finally {
        setLoaded(true);
      }
    };
    fetch();
  }, [dataProvider]);

  return { allTeachers, allPlaces, allGroups, allEventTypes, allAudiences, loaded };
}

/* ───────────── Event Create ───────────── */

/**
 * Convert an AnalysisResult + ScannedFile[] into InferredSession[] and a
 * corrections map. The corrections map is keyed by corrected filename
 * (which becomes the canonical `originalFilename` stored in the DB).
 */
function analysisToInferredSessions(
  result: AnalysisResult,
  scannedFiles: ScannedFile[],
): { sessions: InferredSession[]; corrections: TrackCorrectionsMap } {
  // Index File objects by their original filename (basename of relativePath).
  const filesByOriginalName = new Map<string, File>();
  for (const sf of scannedFiles) {
    const idx = sf.relativePath.lastIndexOf("/");
    const basename = idx === -1 ? sf.relativePath : sf.relativePath.slice(idx + 1);
    filesByOriginalName.set(basename, sf.file);
  }

  const corrections: TrackCorrectionsMap = new Map<string, TrackCorrection[]>();

  const sessions: InferredSession[] = result.sessions.map((s) => {
    const tracks: ParsedTrack[] = s.tracks.map((t) => {
      const file = filesByOriginalName.get(t.originalFilename);
      if (!file) {
        throw new Error(
          `AI returned an unknown filename: "${t.originalFilename}". ` +
          `Available files: ${[...filesByOriginalName.keys()].join(", ")}`,
        );
      }

      // Parse the original file to recover structural metadata
      // (track number, speaker, languages, etc.), then override with AI values.
      const parsed = parseTrackFile(file);

      if (t.corrections.length > 0) {
        // Key by the file's stable id so the badge survives filename edits
        // (SessionTrackTable looks corrections up via track.key === fileKey).
        corrections.set(fileKey(file), t.corrections);
      }

      return {
        ...parsed,
        // The AI-cleaned display title (in the track's own language), falling
        // back to the parser's title if the AI didn't touch it.
        title: t.title || parsed.title,
        // Languages come from the authoritative backend parser (carried through
        // the analysis result), which handles multi-language files like
        // [TIB+ENG]. Fall back to the client parse only if absent.
        languages: t.languages ?? parsed.languages,
        originalLanguage: t.originalLanguage ?? parsed.originalLanguage,
        isTranslation: t.isTranslation ?? parsed.isTranslation,
        // The corrected filename becomes the canonical filename — used for S3
        // uploads and stored in the DB. The key for SessionTrackTable is also
        // this value (via the `key` field set in sessionsToTableValue).
        originalFilename: t.correctedFilename,
        // Keep the File reference from the original scan (unchanged).
        file,
      } satisfies ParsedTrack;
    });

    return {
      sessionNumber: s.sessionNumber,
      date: s.sessionDate,
      timePeriod: s.timePeriod,
      titleEn: s.titleEn,
      // The AI analysis already proposes a PT title alongside the EN one (see
      // `AnalysisSession` in analyzeFolder.ts) — carry it through rather than
      // discarding it. Reviewed flags default true here to match this same
      // screen's existing convention for AI-derived event-level fields (see
      // `handleAnalyzed`, which leaves `EMPTY_FORM`'s reviewed defaults
      // untouched rather than flagging them unreviewed like the Migration
      // screen does).
      titlePt: s.titlePt,
      titleEnReviewed: true,
      titlePtReviewed: true,
      tracks,
    } satisfies InferredSession;
  });

  return { sessions, corrections };
}

const stringArraysEqual = (a: string[], b: string[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Bridge EventCreate's `InferredSession[]` to the shared table's neutral
 * model. A `WeakMap` keyed by `ParsedTrack` caches the produced `TableTrack`,
 * so unchanged tracks keep their object identity across renders — that is
 * what lets `<TrackRow memo>` skip a re-render when another row was edited.
 * The reverse adapter below cooperates by returning the original `ParsedTrack`
 * unchanged when no editable field actually changed; combined the two keep
 * the cache hot.
 */
const tableTrackForParsedTrack = new WeakMap<ParsedTrack, TableTrack>();

/**
 * Stable per-File identity. The dropped `File` object survives filename edits
 * (it's carried through unchanged), so it makes a reliable table row key —
 * unlike the filename, which the admin can now edit. Keeping the key stable is
 * what lets the filename input keep focus while typing.
 */
const fileKeys = new WeakMap<File, string>();
let fileKeyCounter = 0;
function fileKey(file: File): string {
  let k = fileKeys.get(file);
  if (!k) {
    k = `f${fileKeyCounter++}`;
    fileKeys.set(file, k);
  }
  return k;
}


function sessionsToTableValue(sessions: InferredSession[]): TableValue {
  return {
    sessions: sessions.map((s) => ({
      titleEn: s.titleEn,
      sessionDate: s.date,
      timePeriod: s.timePeriod,
      tracks: s.tracks.map((t) => {
        let tt = tableTrackForParsedTrack.get(t);
        if (!tt) {
          tt = {
            // Stable key from the File — survives filename edits.
            key: fileKey(t.file),
            uploadFilename: t.originalFilename,
            trackNumber: t.trackNumber,
            title: t.title,
            speaker: t.speaker,
            languages: t.languages,
            originalLanguage: t.originalLanguage,
            isTranslation: t.isTranslation,
            isPractice: t.isPractice ?? false,
          };
          tableTrackForParsedTrack.set(t, tt);
        }
        return tt;
      }),
    })),
    ignored: [],
  };
}

/**
 * Merge table edits back into `InferredSession[]`, preserving each
 * `ParsedTrack`'s non-editable fields (File, mediaType, date, …) by key (the
 * originalFilename). When *no* editable field actually changed, the original
 * `ParsedTrack` reference is returned unchanged so the forward adapter's
 * `WeakMap` cache stays hot.
 */
function tableValueToSessions(
  tv: TableValue,
  original: InferredSession[],
): InferredSession[] {
  const baseByKey = new Map<string, ParsedTrack>();
  for (const s of original) {
    for (const t of s.tracks) baseByKey.set(fileKey(t.file), t);
  }
  return tv.sessions.map((s, i) => {
    // `TableSession` (the table's neutral model) has no titlePt/reviewed
    // fields — carry them forward from the original session at this index so
    // editing tracks/title in the table doesn't clobber AI- or DB-sourced PT
    // titles. A session appended via "+ Add session" has no `original[i]`
    // counterpart, so it gets the same blank/reviewed-true defaults as any
    // other brand-new session.
    const origSession = original[i];
    return {
      sessionNumber: i + 1,
      date: s.sessionDate,
      timePeriod: s.timePeriod,
      titleEn: s.titleEn,
      titlePt: origSession?.titlePt ?? "",
      titleEnReviewed: origSession?.titleEnReviewed ?? true,
      titlePtReviewed: origSession?.titlePtReviewed ?? true,
      tracks: s.tracks.map((t) => {
        const base = baseByKey.get(t.key);
        if (!base) throw new Error(`unknown track key ${t.key}`);
        if (
          base.trackNumber === t.trackNumber &&
          base.title === t.title &&
          base.speaker === t.speaker &&
          stringArraysEqual(base.languages, t.languages) &&
          base.originalLanguage === t.originalLanguage &&
          base.isTranslation === t.isTranslation &&
          (base.isPractice ?? false) === t.isPractice &&
          base.originalFilename === t.uploadFilename
        ) {
          return base;
        }
        return {
          ...base,
          trackNumber: t.trackNumber,
          title: t.title,
          speaker: t.speaker,
          languages: t.languages,
          originalLanguage: t.originalLanguage,
          isTranslation: t.isTranslation,
          isPractice: t.isPractice,
          // The edited filename becomes the canonical upload name (the S3 key).
          originalFilename: t.uploadFilename,
        } satisfies ParsedTrack;
      }),
    };
  });
}

export const EventCreate = () => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const redirect = useRedirect();
  const translate = useTranslate();

  const [form, setForm] = useState<EventFormData>({ ...EMPTY_FORM });
  const [sessions, setSessions] = useState<InferredSession[]>([]);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressData | null>(null);
  const cancelUploadRef = useRef<(() => void) | null>(null);
  const [transcriptUploads, setTranscriptUploads] = useState<TranscriptUploadState[]>([]);

  // AI analysis state
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [scannedFiles, setScannedFiles] = useState<ScannedFile[]>([]);
  const [trackCorrections, setTrackCorrections] = useState<TrackCorrectionsMap>(new Map());

  const { allTeachers, allPlaces, allGroups, allEventTypes, allAudiences, loaded: lookupsLoaded } = useLookups(dataProvider);
  const [selectedTeachers, setSelectedTeachers] = useState<TeacherOption[]>([]);
  const [selectedPlaces, setSelectedPlaces] = useState<PlaceOption[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<GroupOption[]>([]);
  const [selectedEventType, setSelectedEventType] = useState<EventTypeOption | null>(null);
  const [selectedAudience, setSelectedAudience] = useState<AudienceOption | null>(null);

  // Auto-generate event code from date, teachers, event type, place
  useEffect(() => {
    if (!form.startDate) return;
    const parts: string[] = [];
    let datePart = form.startDate.replace(/-/g, "");
    if (form.endDate && form.endDate !== form.startDate) {
      const [, startMonth] = form.startDate.split("-");
      const [, endMonth, endDay] = form.endDate.split("-");
      datePart += endMonth !== startMonth ? `_${endMonth}${endDay}` : `_${endDay}`;
    }
    parts.push(datePart);
    if (selectedTeachers.length > 0) parts.push(selectedTeachers.map((t) => t.abbreviation).join("-"));
    if (selectedEventType) {
      if (isParallelRetreats(selectedEventType) && selectedGroups.length > 0) {
        // Use group abbreviation(s) instead of "RET" in the event code
        const groupAbbrevs = selectedGroups.map((g) => g.abbreviation).filter(Boolean);
        if (groupAbbrevs.length > 0) {
          parts.push(groupAbbrevs.join("-"));
        } else {
          parts.push(selectedEventType.abbreviation);
        }
      } else {
        parts.push(selectedEventType.abbreviation);
      }
    }
    const placeAbbrevs = selectedPlaces.map((p) => p.abbreviation).filter(Boolean);
    if (placeAbbrevs.length > 0) parts.push(placeAbbrevs.join("-"));
    setForm((prev) => ({ ...prev, eventCode: parts.join("-") }));
  }, [form.startDate, form.endDate, selectedEventType, selectedTeachers, selectedPlaces, selectedGroups]);

  const handleAnalyzed = useCallback(
    (result: AnalysisResult, files: ScannedFile[], droppedFolderName: string) => {
      let inferredSessions: InferredSession[];
      let newCorrections: TrackCorrectionsMap;

      try {
        const out = analysisToInferredSessions(result, files);
        inferredSessions = out.sessions;
        newCorrections = out.corrections;
      } catch (err) {
        notify(`Failed to process AI analysis: ${(err as Error).message}`, { type: "error" });
        return;
      }

      setAnalysis(result);
      setScannedFiles(files);
      setSessions(inferredSessions);
      setFolderName(droppedFolderName);
      setTrackCorrections(newCorrections);

      setForm((prev) => ({
        ...prev,
        titleEn: prev.titleEn || result.event.titleEn || "",
        titlePt: prev.titlePt || result.event.titlePt || "",
        startDate: prev.startDate || result.event.startDate || "",
        endDate: prev.endDate || result.event.endDate || "",
      }));

      if (result.event.matchedTeacherIds.length > 0 && allTeachers.length > 0) {
        const ids = new Set(result.event.matchedTeacherIds.map(Number));
        const matched = allTeachers.filter((t) => ids.has(t.id));
        if (matched.length > 0) setSelectedTeachers((prev) => (prev.length === 0 ? matched : prev));
      }
      if (result.event.matchedGroupIds.length > 0 && allGroups.length > 0) {
        const ids = new Set(result.event.matchedGroupIds.map(Number));
        const matched = allGroups.filter((g) => ids.has(g.id));
        if (matched.length > 0) setSelectedGroups((prev) => (prev.length === 0 ? matched : prev));
      }
      if (result.event.matchedPlaceIds.length > 0 && allPlaces.length > 0) {
        const ids = new Set(result.event.matchedPlaceIds.map(Number));
        const matched = allPlaces.filter((p) => ids.has(p.id));
        if (matched.length > 0) setSelectedPlaces((prev) => (prev.length === 0 ? matched : prev));
      }
      if (result.event.matchedEventTypeId && allEventTypes.length > 0) {
        const match = allEventTypes.find(
          (et) => String(et.id) === result.event.matchedEventTypeId,
        );
        if (match) setSelectedEventType((prev) => prev ?? match);
      }
    },
    [allTeachers, allGroups, allPlaces, allEventTypes, setSelectedEventType, notify],
  );

  /**
   * Reset the dropzone so the admin can re-drop the folder.
   * Future improvement: in-place retry from cached scannedFiles.
   */
  const handleRetryAi = useCallback(() => {
    setAnalysis(null);
    setSessions([]);
    setTrackCorrections(new Map());
    setScannedFiles([]);
    setFolderName(null);
    // Also clear AI-derived form metadata and lookups so the next folder
    // starts from a clean slate. Otherwise stale teacher/group selections
    // from the previous folder linger silently.
    setForm({ ...EMPTY_FORM });
    setSelectedTeachers([]);
    setSelectedGroups([]);
    setSelectedPlaces([]);
    setSelectedEventType(null);
    setSelectedAudience(null);
  }, []);

  /**
   * Export the current track list to .xlsx for human review — original vs
   * corrected filename and title side by side, with a column explaining what
   * the AI changed. Lets a Portuguese reviewer validate Claude's corrections.
   */
  const handleExportForReview = useCallback(() => {
    const rows: TrackExportRow[] = [];
    for (const session of sessions) {
      const sessionLabel = session.titleEn || `Session ${session.sessionNumber}`;
      for (const track of session.tracks) {
        const corr = trackCorrections.get(fileKey(track.file)) ?? [];
        const titleCorr = corr.find((c) => c.field === "title");
        const changes = corr
          .map((c) => `${correctionFieldLabel(c.field)}: ${correctionKindLabel(c.kind)}`)
          .join("; ");
        rows.push({
          session: sessionLabel,
          trackNumber: track.trackNumber,
          // The File's own name is the true source; the ParsedTrack's
          // originalFilename now holds the (possibly edited) upload name.
          originalFilename: track.file.name,
          correctedFilename: track.originalFilename,
          originalTitle: titleCorr?.before ?? track.title,
          correctedTitle: track.title,
          changes,
        });
      }
    }
    const base = (form.eventCode || folderName || "event").replace(/[^\w.-]+/g, "_");
    exportTracksToXlsx(rows, `${base}-tracks-review.xlsx`).catch((err) =>
      notify(`Export failed: ${(err as Error).message}`, { type: "error" }),
    );
  }, [sessions, trackCorrections, form.eventCode, folderName, notify]);

  /** Upload transcript PDFs after the event has been created (so we have eventCode). */
  const handleTranscriptFilesDropped = useCallback(
    async (files: File[]) => {
      if (!form.eventCode) {
        notify(translate("padmakara.transcript.saveFirst") || "Save the event first, then upload transcripts", { type: "warning" });
        return;
      }
      const initial: TranscriptUploadState[] = files.map((f) => ({
        filename: f.name,
        status: "pending",
        progress: 0,
      }));
      setTranscriptUploads((prev) => [...prev, ...initial]);

      for (const file of files) {
        setTranscriptUploads((prev) =>
          prev.map((u) => u.filename === file.name && u.status === "pending"
            ? { ...u, status: "uploading" }
            : u),
        );
        try {
          await uploadTranscript(form.eventCode, file, (progress) => {
            setTranscriptUploads((prev) =>
              prev.map((u) => u.filename === file.name ? { ...u, progress } : u),
            );
          });
          setTranscriptUploads((prev) =>
            prev.map((u) => u.filename === file.name ? { ...u, status: "done", progress: 1 } : u),
          );
          notify(`${file.name} — ${translate("padmakara.transcript.uploadSuccess") || "uploaded"}`, { type: "success" });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          setTranscriptUploads((prev) =>
            prev.map((u) => u.filename === file.name ? { ...u, status: "error", error: msg } : u),
          );
          notify(`${translate("padmakara.transcript.uploadFailed") || "Upload failed"}: ${msg}`, { type: "error" });
        }
      }
    },
    [form.eventCode, notify, translate],
  );

  const handleSave = async () => {
    const problems = validateImportEvent({
      eventCode: form.eventCode,
      titleEn: form.titleEn,
      startDate: form.startDate,
      endDate: form.endDate,
      eventTypeSelected: selectedEventType !== null,
      audienceSelected: selectedAudience !== null,
      teacherCount: selectedTeachers.length,
      placeCount: selectedPlaces.length,
      sessions,
    });
    if (problems.length > 0) {
      notify(["Cannot create the event — please fix:", ...problems].join("\n"), {
        type: "warning",
        multiLine: true,
      });
      return;
    }
    setSaving(true);
    try {
      const { data: event } = await dataProvider.create("events", {
        data: {
          ...form,
          startDate: form.startDate || null,
          endDate: form.endDate || null,
          eventTypeId: selectedEventType?.id ?? null,
          audienceId: selectedAudience?.id ?? null,
          teacherIds: selectedTeachers.map((t) => ({ id: t.id, role: "teacher" as const })),
          placeIds: selectedPlaces.map((p) => p.id),
          groupIds: selectedGroups.map((g) => g.id),
        },
      });

      const uploadItems: UploadItem[] = [];

      for (const session of sessions) {
        const { data: createdSession } = await dataProvider.create("sessions", {
          data: {
            eventId: event.id,
            sessionNumber: session.sessionNumber,
            titleEn: session.titleEn,
            sessionDate: toIsoDate(session.date, form.startDate) || null,
            timePeriod: session.timePeriod || null,
          },
        });
        let videoPositionForSession = 0;
        for (const track of session.tracks) {
          if (track.mediaType === "video") {
            // Videos attach to the session as their own session_videos rows —
            // no track row is created. The uploader creates that row once
            // Bunny finishes transcoding. New sessions always start with zero
            // videos, so position is just this session's running count.
            uploadItems.push({
              // trackId is unused on the video path; satisfy the type with -1.
              trackId: -1,
              sessionId: createdSession.id,
              sessionNumber: session.sessionNumber,
              file: track.file,
              filename: track.originalFilename,
              mediaType: "video",
              title: track.title,
              position: videoPositionForSession++,
            });
            continue;
          }

          const { data: createdTrack } = await dataProvider.create("tracks", {
            data: {
              sessionId: createdSession.id,
              trackNumber: track.trackNumber,
              title: track.title,
              speaker: track.speaker,
              languages: track.languages,
              originalLanguage: track.originalLanguage,
              isTranslation: track.isTranslation,
              originalFilename: track.originalFilename,
              fileSizeBytes: track.file.size,
            },
          });
          uploadItems.push({
            trackId: createdTrack.id,
            sessionNumber: session.sessionNumber,
            file: track.file,
            filename: track.originalFilename,
            mediaType: "audio",
            title: track.title,
          });
        }
      }

      setSaving(false);

      if (uploadItems.length > 0) {
        const { promise, cancel } = uploadTracks(
          uploadItems,
          form.eventCode,
          (progress) => setUploadProgress({ ...progress }),
        );
        cancelUploadRef.current = cancel;

        try {
          await promise;
          notify(translate("padmakara.events.createdUploaded"), { type: "success" });
          redirect("list", "events");
        } catch {
          // Error/cancel already shown in UploadProgress
        }
      } else {
        notify(translate("padmakara.events.createdSuccess"), { type: "success" });
        redirect("list", "events");
      }
    } catch (error: any) {
      notify(`Error: ${error.message}`, { type: "error" });
      setSaving(false);
    }
  };

  const hasFolder = sessions.length > 0;

  return (
    <Box sx={{ px: 3, pb: 6 }}>
      <Title title={translate("padmakara.events.newEvent")} />
      <PageHeader title={translate("padmakara.events.newEvent")} backLabel={translate("padmakara.events.back")} onBack={() => redirect("list", "events")} />

      {!hasFolder && (
        <Paper sx={{ p: 3 }}>
          <TrackAnalysisDropZone
            onAnalyzed={handleAnalyzed}
            onError={(err) =>
              notify("padmakara.import.analyzeError", {
                type: "error",
                messageArgs: { error: err.message },
              })
            }
            authToken={localStorage.getItem("accessToken") ?? ""}
            apiBase="/api"
            fileCount={0}
            folderName={null}
          />
        </Paper>
      )}

      {hasFolder && !uploadProgress && (
        <>
          {/* AI analysis report at the TOP so the admin sees the
              degradation banner immediately on arrival. Notes follow. */}
          {analysis && (
            <AnalysisReport
              notes={analysis.notes}
              aiCoverage={analysis.aiCoverage}
              onRetryAi={handleRetryAi}
              onExport={sessions.length > 0 ? handleExportForReview : undefined}
            />
          )}

          {/* Event details — the track table replaces the old
              section-2 sessions list, so pass empty arrays here. */}
          <EventFormFields
            form={form} setForm={setForm}
            selectedTeachers={selectedTeachers} setSelectedTeachers={setSelectedTeachers}
            selectedPlaces={selectedPlaces} setSelectedPlaces={setSelectedPlaces}
            selectedGroups={selectedGroups} setSelectedGroups={setSelectedGroups}
            selectedEventType={selectedEventType} setSelectedEventType={setSelectedEventType}
            selectedAudience={selectedAudience} setSelectedAudience={setSelectedAudience}
            allTeachers={allTeachers} allPlaces={allPlaces} allGroups={allGroups}
            allEventTypes={allEventTypes} allAudiences={allAudiences}
            sessions={[]} transcripts={[]} eventFiles={[]} onSessionTitleChange={() => {}}
            trackCount={0}
            transcriptCount={0}
          />

          {/* Review & edit the parsed tracks/sessions before saving */}
          <SessionTrackTable
            value={sessionsToTableValue(sessions)}
            onChange={(tv) => setSessions(tableValueToSessions(tv, sessions))}
            teachers={allTeachers}
            enablePractice
            enableAiRename
            editableFilename
            trackCorrections={trackCorrections}
          />

          {/* 6.1 — Transcript upload (allowed before or after save; eventCode needed) */}
          {form.eventCode && (
            <Paper sx={{ p: 3, mb: 3 }}>
              <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600, color: "text.secondary" }}>
                {translate("padmakara.transcript.sectionTitle") || "Transcripts"}
              </Typography>
              <TranscriptDropZone
                onFilesDropped={handleTranscriptFilesDropped}
                uploads={transcriptUploads}
                disabled={saving}
              />
            </Paper>
          )}

          {saving && <LinearProgress sx={{ mb: 2, borderRadius: 1 }} />}
          <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 2 }}>
            <Button variant="outlined" onClick={() => redirect("list", "events")} disabled={saving}>
              {translate("padmakara.events.cancel")}
            </Button>
            <Button
              variant="contained"
              size="large"
              startIcon={<SaveIcon />}
              onClick={handleSave}
              disabled={saving || !form.eventCode || !form.titleEn}
              sx={{ px: 4, py: 1.2, fontSize: "0.95rem" }}
            >
              {saving ? translate("padmakara.events.saving") : translate("padmakara.events.createEvent")}
            </Button>
          </Box>
        </>
      )}

      {uploadProgress && (
        <UploadProgress
          progress={uploadProgress}
          onCancel={() => {
            cancelUploadRef.current?.();
            setUploadProgress(null);
            redirect("list", "events");
          }}
        />
      )}
    </Box>
  );
};

/* ───────────── Event Edit ───────────── */

/** Convert DB sessions+tracks into InferredSession[] for the SessionPreview */
function toInferredSessions(dbSessions: any[]): InferredSession[] {
  const LANG_ORDER: Record<string, number> = { en: 0, pt: 1, es: 2, fr: 3 };
  return dbSessions.map((s) => ({
    id: s.id, // Preserve database session id for transcript matching
    sessionNumber: s.sessionNumber,
    date: s.sessionDate || null,
    timePeriod: s.timePeriod || null,
    titleEn: s.titleEn || `Session ${s.sessionNumber}`,
    titlePt: s.titlePt || "",
    titleEnReviewed: s.titleEnReviewed ?? true,
    titlePtReviewed: s.titlePtReviewed ?? true,
    videos: (s.videos || []) as SessionVideo[],
    tracks: (s.tracks || []).map((t: any) => ({
      id: t.id,
      trackNumber: t.trackNumber,
      title: t.title,
      speaker: t.speaker || null,
      languages: t.languages || [t.originalLanguage || "en"],
      originalLanguage: t.originalLanguage || "en",
      isTranslation: t.isTranslation,
      originalFilename: t.originalFilename || "",
      file: { name: t.originalFilename || t.title, size: t.fileSizeBytes || 0 } as File,
      date: s.sessionDate || null,
      timePeriod: s.timePeriod || null,
      partNumber: null,
      isPractice: t.isPractice || false,
      fileFormat: t.fileFormat || null,
    })).sort((a: any, b: any) => {
      if (a.trackNumber !== b.trackNumber) return a.trackNumber - b.trackNumber;
      const transOrd = (a.isTranslation ? 1 : 0) - (b.isTranslation ? 1 : 0);
      if (transOrd !== 0) return transOrd;
      return (LANG_ORDER[a.originalLanguage] ?? 4) - (LANG_ORDER[b.originalLanguage] ?? 4);
    }),
  }));
}

export const EventEdit = () => {
  const { id } = useParams<{ id: string }>();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const redirect = useRedirect();
  const translate = useTranslate();
  const refresh = useRefresh();

  const { data: event, isPending } = useGetOne("events", { id: id! }, {
    enabled: !!id,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  const [form, setForm] = useState<EventFormData>({ ...EMPTY_FORM });
  const [sessions, setSessions] = useState<InferredSession[]>([]);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressData | null>(null);
  const cancelUploadRef = useRef<(() => void) | null>(null);
  const [transcriptUploads, setTranscriptUploads] = useState<TranscriptUploadState[]>([]);
  // 6.2 — new-tracks drop state (used when adding sessions to an existing event)
  const [addTracksUploading, setAddTracksUploading] = useState(false);

  const { allTeachers, allPlaces, allGroups, allEventTypes, allAudiences, loaded: lookupsLoaded } = useLookups(dataProvider);
  const [selectedTeachers, setSelectedTeachers] = useState<TeacherOption[]>([]);
  const [selectedPlaces, setSelectedPlaces] = useState<PlaceOption[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<GroupOption[]>([]);
  const [selectedEventType, setSelectedEventType] = useState<EventTypeOption | null>(null);
  const [selectedAudience, setSelectedAudience] = useState<AudienceOption | null>(null);

  useEffect(() => {
    if (!event || !lookupsLoaded || initialized) return;

    setForm({
      eventCode: event.eventCode || "",
      titleEn: event.titleEn || "",
      titlePt: event.titlePt || "",
      mainThemesPt: event.mainThemesPt || "",
      mainThemesEn: event.mainThemesEn || "",
      sessionThemesEn: event.sessionThemesEn || "",
      sessionThemesPt: event.sessionThemesPt || "",
      startDate: event.startDate || "",
      endDate: event.endDate || "",
      status: event.status || "draft",
      featuredAt: event.featuredAt || null,
      titleEnReviewed: event.titleEnReviewed ?? true,
      titlePtReviewed: event.titlePtReviewed ?? true,
      mainThemesEnReviewed: event.mainThemesEnReviewed ?? true,
      mainThemesPtReviewed: event.mainThemesPtReviewed ?? true,
      sessionThemesEnReviewed: event.sessionThemesEnReviewed ?? true,
      sessionThemesPtReviewed: event.sessionThemesPtReviewed ?? true,
    });

    if (event.eventTeachers && allTeachers.length > 0) {
      const ids = new Set(event.eventTeachers.map((rt: any) => rt.teacherId));
      setSelectedTeachers(allTeachers.filter((t) => ids.has(t.id)));
    }
    if (event.eventPlaces && allPlaces.length > 0) {
      const ids = new Set(event.eventPlaces.map((rp: any) => rp.placeId));
      setSelectedPlaces(allPlaces.filter((p) => ids.has(p.id)));
    }
    if (event.eventRetreatGroups && allGroups.length > 0) {
      const ids = new Set(event.eventRetreatGroups.map((rg: any) => rg.retreatGroupId));
      setSelectedGroups(allGroups.filter((g) => ids.has(g.id)));
    }

    if (event.eventType && allEventTypes.length > 0) {
      const matched = allEventTypes.find((et) => et.id === event.eventType.id);
      if (matched) setSelectedEventType(matched);
    }
    if (event.audience && allAudiences.length > 0) {
      const matched = allAudiences.find((a) => a.id === event.audience.id);
      if (matched) setSelectedAudience(matched);
    }

    setInitialized(true);
  }, [event, allTeachers, allPlaces, allGroups, allEventTypes, allAudiences, lookupsLoaded, initialized]);

  // Separate effect for loading sessions - runs whenever event.sessions changes
  // This prevents the race condition where cached event data (without sessions)
  // arrives first and sets initialized=true, blocking session loading when full data arrives
  useEffect(() => {
    if (event?.sessions && event.sessions.length > 0) {
      setSessions(toInferredSessions(event.sessions));
    }
  }, [event?.sessions]);

  const handleSessionTitleChange = useCallback(
    (idx: number, title: string) => {
      setSessions((prev) => prev.map((s, i) => (i === idx ? { ...s, titleEn: title } : s)));
    },
    [],
  );

  const handleTrackUpdate = useCallback(
    async (trackId: number, updates: Partial<ParsedTrack>) => {
      try {
        await dataProvider.update("tracks", {
          id: trackId,
          data: {
            title: updates.title,
            originalFilename: updates.originalFilename,
            languages: updates.languages,
            originalLanguage: updates.originalLanguage,
            isPractice: updates.isPractice,
            isTranslation: updates.isTranslation,
            speaker: updates.speaker,
          },
          previousData: {},
        });

        // Update local state to reflect changes
        setSessions((prev) =>
          prev.map((session) => ({
            ...session,
            tracks: session.tracks.map((track) =>
              track.id === trackId
                ? {
                    ...track,
                    title: updates.title ?? track.title,
                    originalFilename: updates.originalFilename ?? track.originalFilename,
                    languages: updates.languages ?? track.languages,
                    originalLanguage: updates.originalLanguage ?? track.originalLanguage,
                    isPractice: updates.isPractice ?? track.isPractice,
                    isTranslation: updates.isTranslation ?? track.isTranslation,
                    speaker: updates.speaker ?? track.speaker,
                  }
                : track
            ),
          }))
        );

        notify(translate("padmakara.events.trackUpdated"), { type: "success" });
        // Invalidate cached event data so changes persist on re-navigation
        refresh();
      } catch (error: any) {
        notify(`Error updating track: ${error.message}`, { type: "error" });
        throw error;
      }
    },
    [dataProvider, notify, translate, refresh]
  );

  const handleTrackDelete = useCallback(
    async (trackId: number) => {
      try {
        await dataProvider.delete("tracks", {
          id: trackId,
          previousData: { id: trackId },
        });

        // Drop the row from local state so the list shrinks immediately
        // without waiting for the refetch.
        setSessions((prev) =>
          prev.map((session) => ({
            ...session,
            tracks: session.tracks.filter((t) => t.id !== trackId),
          })),
        );

        notify(translate("padmakara.tracks.deleted") || "Track deleted", {
          type: "success",
        });
        refresh();
      } catch (error: any) {
        notify(
          translate("padmakara.tracks.deleteFailed") || "Could not delete track",
          { type: "error" },
        );
        throw error;
      }
    },
    [dataProvider, notify, translate, refresh],
  );

  // Single-video upload from the edit page. Drives the same UploadProgress
  // overlay used by the create wizard so progress + transcoding feedback look
  // identical. The promise resolves once Bunny finishes transcoding and a new
  // `session_videos` row exists for this session (a session may now have
  // several videos — this adds one more, at the next available position).
  const handleSessionVideoUpload = useCallback(
    (sessionId: number, file: File) => {
      const position = sessions.find((s) => s.id === sessionId)?.videos?.length ?? 0;
      const signal: { cancelled: boolean; abort?: () => void } = { cancelled: false };
      cancelUploadRef.current = () => {
        signal.cancelled = true;
        signal.abort?.();
      };

      const baseProgress: UploadProgressData = {
        phase: "uploading",
        currentFilename: file.name,
        fileProgress: 0,
        filesCompleted: 0,
        filesTotal: 1,
        bytesUploaded: 0,
        bytesTotal: file.size,
        speed: 0,
        files: [{ filename: file.name, size: file.size, status: "uploading", progress: 0 }],
      };
      setUploadProgress(baseProgress);

      uploadVideoFile({
        sessionId,
        position,
        title: file.name.replace(/\.[^.]+$/, ""),
        file,
        signal,
        onProgress: (loaded, total) => {
          setUploadProgress((p) => p && {
            ...p,
            phase: "uploading",
            bytesUploaded: loaded,
            bytesTotal: total,
            fileProgress: total > 0 ? loaded / total : 0,
            files: p.files.map((f) =>
              f.filename === file.name ? { ...f, status: "uploading", progress: total > 0 ? loaded / total : 0 } : f,
            ),
          });
        },
        onTranscodingStart: () => {
          setUploadProgress((p) => p && {
            ...p,
            files: p.files.map((f) =>
              f.filename === file.name ? { ...f, status: "transcoding", progress: 1 } : f,
            ),
          });
        },
        onTranscodeStatus: (status) => {
          setUploadProgress((p) => p && {
            ...p,
            files: p.files.map((f) =>
              f.filename === file.name ? { ...f, status: "transcoding", transcodeStatus: status } : f,
            ),
          });
        },
      })
        .then(() => {
          setUploadProgress((p) => p && {
            ...p,
            phase: "done",
            filesCompleted: 1,
            files: p.files.map((f) =>
              f.filename === file.name ? { ...f, status: "done", progress: 1 } : f,
            ),
          });
          notify(translate("padmakara.session.videoUploadSuccess") || "Video uploaded", { type: "success" });
          refresh();
          // Auto-dismiss the success panel after a beat so the admin returns to the list.
          setTimeout(() => setUploadProgress(null), 1500);
        })
        .catch((err: any) => {
          setUploadProgress((p) => p && {
            ...p,
            phase: "error",
            error: err?.message || String(err),
            files: p.files.map((f) =>
              f.filename === file.name ? { ...f, status: "error" } : f,
            ),
          });
          notify(`Video upload failed: ${err?.message || err}`, { type: "error" });
        })
        .finally(() => {
          cancelUploadRef.current = null;
        });
    },
    [notify, refresh, translate, sessions],
  );

  const handleSessionVideoDelete = useCallback(
    async (sessionVideoId: number) => {
      try {
        const res = await authFetch(`/api/admin/session-videos/${sessionVideoId}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`Delete failed (${res.status}): ${await res.text()}`);
        setSessions((prev) =>
          prev.map((s) => ({
            ...s,
            videos: (s.videos ?? []).filter((v) => v.id !== sessionVideoId),
          })),
        );
        notify(translate("padmakara.session.videoDeleted") || "Video removed", { type: "success" });
        refresh();
      } catch (error: any) {
        notify(`Failed to remove video: ${error?.message || error}`, { type: "error" });
        throw error;
      }
    },
    [notify, refresh, translate],
  );

  // 6.1 — Transcript upload handler for EventEdit
  const handleEditTranscriptFilesDropped = useCallback(
    async (files: File[]) => {
      if (!form.eventCode) {
        notify(translate("padmakara.transcript.saveFirst") || "Save the event first, then upload transcripts", { type: "warning" });
        return;
      }
      const initial: TranscriptUploadState[] = files.map((f) => ({
        filename: f.name,
        status: "pending",
        progress: 0,
      }));
      setTranscriptUploads((prev) => [...prev, ...initial]);

      for (const file of files) {
        setTranscriptUploads((prev) =>
          prev.map((u) => u.filename === file.name && u.status === "pending"
            ? { ...u, status: "uploading" }
            : u),
        );
        try {
          await uploadTranscript(form.eventCode, file, (progress) => {
            setTranscriptUploads((prev) =>
              prev.map((u) => u.filename === file.name ? { ...u, progress } : u),
            );
          });
          setTranscriptUploads((prev) =>
            prev.map((u) => u.filename === file.name ? { ...u, status: "done", progress: 1 } : u),
          );
          notify(`${file.name} — ${translate("padmakara.transcript.uploadSuccess") || "uploaded"}`, { type: "success" });
          refresh();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          setTranscriptUploads((prev) =>
            prev.map((u) => u.filename === file.name ? { ...u, status: "error", error: msg } : u),
          );
          notify(`${translate("padmakara.transcript.uploadFailed") || "Upload failed"}: ${msg}`, { type: "error" });
        }
      }
    },
    [form.eventCode, notify, refresh, translate],
  );

  // 6.2 — Add sessions/tracks to existing event
  const handleAddFolderDropped = useCallback(
    async (meta: FolderMetadata, tracks: ParsedTrack[]) => {
      if (!form.eventCode || !id) {
        notify("Save the event first before adding new sessions", { type: "warning" });
        return;
      }
      setAddTracksUploading(true);
      try {
        const inferredNewSessions = inferSessions(tracks);
        const existingSessionNumbers = new Set(sessions.map((s) => s.sessionNumber));
        // Assign new session numbers that don't conflict with existing ones
        const maxExisting = sessions.reduce((m, s) => Math.max(m, s.sessionNumber), 0);
        let nextSessionNumber = maxExisting + 1;

        const uploadItems: UploadItem[] = [];

        for (const session of inferredNewSessions) {
          const sessionNumber = existingSessionNumbers.has(session.sessionNumber)
            ? nextSessionNumber++
            : session.sessionNumber;

          const { data: createdSession } = await dataProvider.create("sessions", {
            data: {
              eventId: id,
              sessionNumber,
              titleEn: session.titleEn,
              sessionDate: session.date || null,
              timePeriod: session.timePeriod || null,
            },
          });

          let videoPositionForSession = 0;
          for (const track of session.tracks) {
            if (track.mediaType === "video") {
              uploadItems.push({
                trackId: -1,
                sessionId: createdSession.id,
                sessionNumber,
                file: track.file,
                filename: track.originalFilename,
                mediaType: "video",
                title: track.title,
                position: videoPositionForSession++,
              });
              continue;
            }
            const { data: createdTrack } = await dataProvider.create("tracks", {
              data: {
                sessionId: createdSession.id,
                trackNumber: track.trackNumber,
                title: track.title,
                speaker: track.speaker,
                languages: track.languages,
                originalLanguage: track.originalLanguage,
                isTranslation: track.isTranslation,
                originalFilename: track.originalFilename,
                fileSizeBytes: track.file.size,
              },
            });
            uploadItems.push({
              trackId: createdTrack.id,
              sessionNumber,
              file: track.file,
              filename: track.originalFilename,
              mediaType: "audio",
              title: track.title,
            });
          }
        }

        if (uploadItems.length > 0) {
          const { promise, cancel } = uploadTracks(
            uploadItems,
            form.eventCode,
            (progress) => setUploadProgress({ ...progress }),
          );
          cancelUploadRef.current = cancel;
          try {
            await promise;
            notify("Sessions and tracks added and uploaded", { type: "success" });
            refresh();
          } catch {
            // Error shown in UploadProgress
          } finally {
            setUploadProgress(null);
          }
        } else {
          notify("Sessions added (no audio to upload)", { type: "success" });
          refresh();
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(`Error adding sessions: ${msg}`, { type: "error" });
      } finally {
        setAddTracksUploading(false);
      }
    },
    [form.eventCode, id, sessions, dataProvider, notify, refresh],
  );

  const handleFeaturedToggle = useCallback(async () => {
    if (!id) return;
    const newFeaturedAt = form.featuredAt ? null : new Date().toISOString();
    try {
      await dataProvider.update("events", {
        id,
        data: { featuredAt: newFeaturedAt },
        previousData: event,
      });
      notify(newFeaturedAt ? "Event set as featured" : "Featured removed", { type: "success" });
    } catch (error: any) {
      notify(`Error: ${error.message}`, { type: "error" });
    }
  }, [id, form.featuredAt, dataProvider, event, notify]);

  const handleStatusChange = useCallback(async (newStatus: string) => {
    if (!id) return;
    try {
      await dataProvider.update("events", {
        id,
        data: { status: newStatus },
        previousData: event,
      });
      notify(`Status changed to ${newStatus}`, { type: "success" });
    } catch (error: any) {
      notify(`Error: ${error.message}`, { type: "error" });
    }
  }, [id, dataProvider, event, notify]);

  const handleSave = async () => {
    if (!form.eventCode || !form.titleEn) {
      notify(translate("padmakara.events.codeAndTitleRequired"), { type: "warning" });
      return;
    }
    setSaving(true);
    try {
      await dataProvider.update("events", {
        id: id!,
        data: {
          ...form,
          startDate: form.startDate || null,
          endDate: form.endDate || null,
          eventTypeId: selectedEventType?.id ?? null,
          audienceId: selectedAudience?.id ?? null,
          teacherIds: selectedTeachers.map((t) => ({ id: t.id, role: "teacher" as const })),
          placeIds: selectedPlaces.map((p) => p.id),
          groupIds: selectedGroups.map((g) => g.id),
        },
        previousData: event,
      });
      notify(translate("padmakara.events.updatedSuccess"), { type: "success" });
      redirect("list", "events");
    } catch (error: any) {
      notify(`Error: ${error.message}`, { type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await dataProvider.delete("events", { id: id!, previousData: event });
      notify(translate("padmakara.events.deletedSuccess"), { type: "success" });
      redirect("list", "events");
    } catch (error: any) {
      notify(`Error: ${error.message}`, { type: "error" });
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  if (isPending) {
    return (
      <Box sx={{ maxWidth: 900, mx: "auto", pt: 4 }}>
        <LinearProgress />
      </Box>
    );
  }

  const trackCount = sessions.reduce((sum, s) => sum + s.tracks.length, 0);
  const transcriptCount = event?.transcripts?.length ?? 0;

  return (
    <Box sx={{ maxWidth: 900, mx: "auto", pb: 6 }}>
      <Title title={`${translate("ra.action.edit")}: ${event?.titleEn || ""}`} />
      <PageHeader title={event?.titleEn || translate("ra.action.edit")} backLabel={translate("padmakara.events.back")} onBack={() => redirect("list", "events")} />

      <EventFormFields
        form={form} setForm={setForm}
        selectedTeachers={selectedTeachers} setSelectedTeachers={setSelectedTeachers}
        selectedPlaces={selectedPlaces} setSelectedPlaces={setSelectedPlaces}
        selectedGroups={selectedGroups} setSelectedGroups={setSelectedGroups}
        selectedEventType={selectedEventType} setSelectedEventType={setSelectedEventType}
        selectedAudience={selectedAudience} setSelectedAudience={setSelectedAudience}
        allTeachers={allTeachers} allPlaces={allPlaces} allGroups={allGroups}
        allEventTypes={allEventTypes} allAudiences={allAudiences}
        sessions={sessions} transcripts={event?.transcripts || []} eventFiles={event?.eventFiles || []} onSessionTitleChange={handleSessionTitleChange}
        onTrackUpdate={handleTrackUpdate}
        onTrackDelete={handleTrackDelete}
        onSessionVideoUpload={handleSessionVideoUpload}
        onSessionVideoDelete={handleSessionVideoDelete}
        onFeaturedToggle={handleFeaturedToggle}
        onStatusChange={handleStatusChange}
        trackCount={trackCount}
        transcriptCount={transcriptCount}
      />

      {/* 6.2 — Add sessions/tracks to an existing event */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600, color: "text.secondary" }}>
          Add audio sessions
        </Typography>
        <TrackDropZone
          onFolderDropped={handleAddFolderDropped}
          fileCount={0}
          folderName={null}
        />
        {addTracksUploading && <LinearProgress sx={{ mt: 1.5, borderRadius: 1 }} />}
      </Paper>

      {/* 6.1 — Transcript upload for existing event */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600, color: "text.secondary" }}>
          {translate("padmakara.transcript.sectionTitle") || "Transcripts"}
        </Typography>
        <TranscriptDropZone
          onFilesDropped={handleEditTranscriptFilesDropped}
          uploads={transcriptUploads}
          disabled={saving}
        />
      </Paper>

      {trackCount > 0 && transcriptCount > 0 && event?.id && (
        <ReadAlongPanel eventId={Number(event.id)} />
      )}

      {sessions.flatMap((s) =>
        (s.videos ?? []).map((v) => (
          <SubtitlePanel
            key={v.id}
            sessionVideoId={v.id}
            videoLabel={
              (s.videos?.length ?? 0) > 1
                ? `${s.titleEn ?? ""} — ${v.title ?? `${translate("padmakara.session.part") || "Part"} ${v.position + 1}`}`
                : (s.titleEn ?? "")
            }
          />
        )),
      )}

      {saving && <LinearProgress sx={{ mb: 2, borderRadius: 1 }} />}
      <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2 }}>
        <Button
          variant="outlined"
          color="error"
          startIcon={<DeleteIcon />}
          onClick={() => setDeleteOpen(true)}
          disabled={saving || deleting}
        >
          {translate("padmakara.events.delete")}
        </Button>
        <Box sx={{ display: "flex", gap: 2 }}>
          <Button variant="outlined" onClick={() => redirect("list", "events")} disabled={saving}>
            {translate("padmakara.events.cancel")}
          </Button>
          <Button
            variant="contained"
            size="large"
            startIcon={<SaveIcon />}
            onClick={handleSave}
            disabled={saving || !form.eventCode || !form.titleEn}
            sx={{ px: 4, py: 1.2, fontSize: "0.95rem" }}
          >
            {saving ? translate("padmakara.events.saving") : translate("padmakara.events.saveChanges")}
          </Button>
        </Box>
      </Box>

      <DeleteConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        eventTitle={event?.titleEn || "this event"}
        deleting={deleting}
      />

      {/* Video upload overlay — only present while a single-video upload is in flight. */}
      {uploadProgress && (
        <Box sx={{ position: "fixed", bottom: 24, right: 24, width: 420, zIndex: 1300 }}>
          <UploadProgress
            progress={uploadProgress}
            onCancel={() => {
              cancelUploadRef.current?.();
              setUploadProgress(null);
            }}
          />
        </Box>
      )}
    </Box>
  );
};

/* ───────────── Delete Confirmation Dialog ───────────── */

const DeleteConfirmDialog = ({
  open,
  onClose,
  onConfirm,
  eventTitle,
  deleting,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  eventTitle: string;
  deleting: boolean;
}) => {
  const translate = useTranslate();
  const [confirmText, setConfirmText] = useState("");
  const confirmed = confirmText.toLowerCase() === "delete";

  return (
    <Dialog open={open} onClose={deleting ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 700, color: "error.main" }}>{translate("padmakara.events.deleteTitle")}</DialogTitle>
      <DialogContent>
        <Typography sx={{ mb: 2 }} dangerouslySetInnerHTML={{ __html: translate("padmakara.events.deleteConfirmMessage", { title: eventTitle }) }} />
        <MuiTextField
          label={translate("padmakara.events.deleteTypeConfirm")}
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
        <Button onClick={onClose} disabled={deleting}>{translate("padmakara.events.cancel")}</Button>
        <Button
          variant="contained"
          color="error"
          startIcon={<DeleteIcon />}
          onClick={onConfirm}
          disabled={!confirmed || deleting}
        >
          {deleting ? translate("padmakara.events.deleting") : translate("padmakara.events.deleteEvent")}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

/* ───────────── Helpers ───────────── */

const PageHeader = ({ title, backLabel, onBack }: { title: string; backLabel: string; onBack: () => void }) => (
  <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 4 }}>
    <Button startIcon={<ArrowBackIcon />} onClick={onBack} sx={{ color: "text.secondary" }}>
      {backLabel}
    </Button>
    <Box sx={{ flex: 1 }} />
    <SpaIcon sx={{ color: "primary.main", fontSize: 28 }} />
    <Typography variant="h5" sx={{ fontWeight: 700 }}>
      {title}
    </Typography>
  </Box>
);

const SectionHeader = ({
  number,
  title,
  subtitle,
  chips,
}: {
  number: number;
  title: string;
  subtitle: string;
  chips?: React.ReactNode;
}) => (
  <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.5, mb: 2, mt: 1 }}>
    <Box
      sx={{
        width: 28,
        height: 28,
        borderRadius: "50%",
        border: "2px solid",
        borderColor: "primary.main",
        color: "primary.main",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "0.78rem",
        fontWeight: 700,
        flexShrink: 0,
        mt: 0.2,
      }}
    >
      {number}
    </Box>
    <Box sx={{ flex: 1 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography variant="h6" sx={{ lineHeight: 1.3 }}>
          {title}
        </Typography>
        {chips}
      </Box>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {subtitle}
      </Typography>
    </Box>
  </Box>
);
