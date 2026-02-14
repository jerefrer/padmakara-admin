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
  useTranslate,
  useLocaleState,
} from "react-admin";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import MuiTextField from "@mui/material/TextField";
import Chip from "@mui/material/Chip";
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
import { useParams } from "react-router-dom";

import { TrackDropZone } from "../components/TrackDropZone";
import { SessionPreview } from "../components/SessionPreview";
import { UploadProgress } from "../components/UploadProgress";
import {
  uploadTracks,
  type UploadItem,
  type UploadProgress as UploadProgressData,
} from "../utils/uploadManager";
import {
  type ParsedTrack,
  type InferredSession,
  type FolderMetadata,
  inferSessions,
} from "../utils/trackParser";

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
      sx={{ fontWeight: 600, textTransform: "capitalize" }}
    />
  );
};

export const EventList = () => {
  const translate = useTranslate();
  const [locale] = useLocaleState();
  return (
    <List
      sort={{ field: "startDate", order: "DESC" }}
      perPage={100}
      pagination={false}
      sx={{ "& .RaList-main": { maxWidth: 1100 } }}
    >
      <Datagrid
        rowClick="edit"
        bulkActionButtons={false}
        sx={{ "& .RaDatagrid-row": { "&:hover": { backgroundColor: "rgba(91,94,166,0.03)" } } }}
      >
        <TextField source="eventCode" label={translate("padmakara.events.code")} sx={{ fontFamily: "monospace", fontWeight: 600 }} />
        <TextField source="titleEn" label={translate("padmakara.events.title")} />
        <FunctionField
          label={translate("padmakara.events.dates")}
          render={(record: any) => {
            if (!record.startDate) return "—";
            const dateLocale = locale === "pt" ? "pt-PT" : "en-GB";
            const startDate = new Date(record.startDate);
            const start = startDate.toLocaleDateString(dateLocale, { day: "numeric", month: "long" });
            if (!record.endDate) {
              return `${start} ${startDate.getFullYear()}`;
            }
            const endDate = new Date(record.endDate);
            const end = endDate.toLocaleDateString(dateLocale, { day: "numeric", month: "long", year: "numeric" });
            return `${start} ${translate("padmakara.events.dateTo")} ${end}`;
          }}
        />
        <FunctionField label={translate("padmakara.events.status")} render={(record: any) => <StatusChip status={record.status} />} />
        <DateField source="createdAt" label={translate("padmakara.events.created")} />
        <EditButton />
      </Datagrid>
    </List>
  );
};

/* ───────────── Shared types & constants ───────────── */

interface EventFormData {
  eventCode: string;
  titleEn: string;
  titlePt: string;
  mainThemesPt: string;
  mainThemesEn: string;
  sessionThemesEn: string;
  sessionThemesPt: string;
  startDate: string;
  endDate: string;
  status: string;
}

interface TeacherOption { id: number; name: string; abbreviation: string }
interface PlaceOption { id: number; name: string; abbreviation: string | null }
interface GroupOption { id: number; nameEn: string; namePt: string | null; slug: string }
interface EventTypeOption { id: number; nameEn: string; namePt: string | null; abbreviation: string; slug: string }
interface AudienceOption { id: number; nameEn: string; namePt: string | null; slug: string }

const EMPTY_FORM: EventFormData = {
  eventCode: "", titleEn: "", titlePt: "",
  mainThemesPt: "", mainThemesEn: "",
  sessionThemesEn: "", sessionThemesPt: "",
  startDate: "", endDate: "", status: "draft",
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
  onSessionTitleChange: (idx: number, title: string) => void;
  trackCount: number;
}

const syncedRows = (a: string, b: string, min = 3) =>
  Math.max(a.split("\n").length, b.split("\n").length, min);

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

const EventFormFields = ({
  form, setForm,
  selectedTeachers, setSelectedTeachers,
  selectedPlaces, setSelectedPlaces,
  selectedGroups, setSelectedGroups,
  selectedEventType, setSelectedEventType,
  selectedAudience, setSelectedAudience,
  allTeachers, allPlaces, allGroups, allEventTypes, allAudiences,
  sessions, onSessionTitleChange, trackCount,
}: EventFormProps) => {
  const translate = useTranslate();
  const [locale] = useLocaleState();

  const updateField =
    (field: keyof EventFormData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
    };

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
          onChange={(_, val) => { if (val) setForm((prev) => ({ ...prev, status: val })); }}
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
      </Box>

      {/* ── Title ── */}
      <Paper sx={{ p: 3, mb: 2 }}>
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
                getOptionLabel={(o) => localeName(o, locale)}
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
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ "& input": { fontFamily: "monospace", fontWeight: 600, letterSpacing: "0.02em" } }}
        />
      </Paper>

      {/* ── Section 2: Sessions & Tracks ── */}
      {sessions.length > 0 && (
        <>
          <SectionHeader
            number={2}
            title={translate("padmakara.events.audioTracks")}
            subtitle={translate("padmakara.events.audioTracksSubtitle")}
            chips={
              <>
                <Chip label={`${sessions.length} ${translate("padmakara.events.sessions", { smart_count: sessions.length })}`} size="small" color="primary" variant="outlined" />
                <Chip label={`${trackCount} ${translate("padmakara.events.tracks", { smart_count: trackCount })}`} size="small" variant="outlined" />
              </>
            }
          />
          <Paper sx={{ p: 3, mb: 3 }}>
            <SessionPreview sessions={sessions} onSessionTitleChange={onSessionTitleChange} />
          </Paper>
        </>
      )}
    </>
  );
};

/* ───────────── Shared hooks ───────────── */

function useLookups(dataProvider: ReturnType<typeof useDataProvider>) {
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

export const EventCreate = () => {
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const redirect = useRedirect();
  const translate = useTranslate();

  const [form, setForm] = useState<EventFormData>({ ...EMPTY_FORM });
  const [parsedTracks, setParsedTracks] = useState<ParsedTrack[]>([]);
  const [sessions, setSessions] = useState<InferredSession[]>([]);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressData | null>(null);
  const cancelUploadRef = useRef<(() => void) | null>(null);

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
      parts.push(selectedEventType.abbreviation);
    }
    const placeAbbrevs = selectedPlaces.map((p) => p.abbreviation).filter(Boolean);
    if (placeAbbrevs.length > 0) parts.push(placeAbbrevs.join("-"));
    setForm((prev) => ({ ...prev, eventCode: parts.join("-") }));
  }, [form.startDate, form.endDate, selectedEventType, selectedTeachers, selectedPlaces]);

  const handleFolderDropped = useCallback(
    (meta: FolderMetadata, tracks: ParsedTrack[]) => {
      setParsedTracks(tracks);
      setSessions(inferSessions(tracks));
      setFolderName(meta.groupSlug ? `${meta.teacherAbbrev ?? ""} – ${meta.groupSlug}` : meta.defaultTitle);
      setForm((prev) => ({
        ...prev,
        titleEn: prev.titleEn || meta.defaultTitle,
        titlePt: prev.titlePt || meta.defaultTitlePt,
        startDate: prev.startDate || meta.startDate || "",
        endDate: prev.endDate || meta.endDate || "",
      }));
      const abbrevs = new Set<string>();
      if (meta.teacherAbbrev) abbrevs.add(meta.teacherAbbrev.toUpperCase());
      for (const track of tracks) {
        if (track.speaker) abbrevs.add(track.speaker.toUpperCase());
      }
      if (abbrevs.size > 0 && allTeachers.length > 0) {
        const matched = allTeachers.filter((t) => abbrevs.has(t.abbreviation.toUpperCase()));
        setSelectedTeachers((prev) => (prev.length === 0 ? matched : prev));
      }
      if (meta.groupSlug && allGroups.length > 0) {
        const slug = meta.groupSlug.toLowerCase();
        const matched = allGroups.filter(
          (g) =>
            g.namePt?.toLowerCase().includes(slug) ||
            g.nameEn.toLowerCase().includes(slug) ||
            g.slug.toLowerCase() === slug.replace(/\s+/g, "-"),
        );
        if (matched.length > 0) {
          setSelectedGroups((prev) => (prev.length === 0 ? matched : prev));
          const parallelRetreats = allEventTypes.find((et) => et.abbreviation === "RET");
          if (parallelRetreats) {
            setSelectedEventType((prev) => prev ?? parallelRetreats);
            const retreatGroupMembers = allAudiences.find((a) => a.nameEn === "Retreat group members");
            if (retreatGroupMembers) setSelectedAudience((prev) => prev ?? retreatGroupMembers);
          }
        }
      }
    },
    [allTeachers, allGroups, allEventTypes, allAudiences],
  );

  const handleSessionTitleChange = useCallback(
    (idx: number, title: string) => {
      setSessions((prev) => prev.map((s, i) => (i === idx ? { ...s, titleEn: title } : s)));
    },
    [],
  );

  const handleSave = async () => {
    if (!form.eventCode || !form.titleEn) {
      notify(translate("padmakara.events.codeAndTitleRequired"), { type: "warning" });
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
        for (const track of session.tracks) {
          const { data: createdTrack } = await dataProvider.create("tracks", {
            data: {
              sessionId: createdSession.id,
              trackNumber: track.trackNumber,
              title: track.title,
              speaker: track.speaker,
              language: track.language,
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
          });
        }
      }

      setSaving(false);

      if (uploadItems.length > 0) {
        const authToken = localStorage.getItem("accessToken") || "";
        const { promise, cancel } = uploadTracks(
          uploadItems,
          form.eventCode,
          authToken,
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

  const hasFolder = parsedTracks.length > 0;

  return (
    <Box sx={{ maxWidth: 900, mx: "auto", pb: 6 }}>
      <Title title={translate("padmakara.events.newEvent")} />
      <PageHeader title={translate("padmakara.events.newEvent")} backLabel={translate("padmakara.events.back")} onBack={() => redirect("list", "events")} />

      {!hasFolder && (
        <Paper sx={{ p: 3 }}>
          <TrackDropZone onFolderDropped={handleFolderDropped} fileCount={0} folderName={null} />
        </Paper>
      )}

      {hasFolder && !uploadProgress && (
        <>
          <EventFormFields
            form={form} setForm={setForm}
            selectedTeachers={selectedTeachers} setSelectedTeachers={setSelectedTeachers}
            selectedPlaces={selectedPlaces} setSelectedPlaces={setSelectedPlaces}
            selectedGroups={selectedGroups} setSelectedGroups={setSelectedGroups}
            selectedEventType={selectedEventType} setSelectedEventType={setSelectedEventType}
            selectedAudience={selectedAudience} setSelectedAudience={setSelectedAudience}
            allTeachers={allTeachers} allPlaces={allPlaces} allGroups={allGroups}
            allEventTypes={allEventTypes} allAudiences={allAudiences}
            sessions={sessions} onSessionTitleChange={handleSessionTitleChange}
            trackCount={parsedTracks.length}
          />

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
  return dbSessions.map((s) => ({
    sessionNumber: s.sessionNumber,
    date: s.sessionDate || null,
    timePeriod: s.timePeriod || null,
    titleEn: s.titleEn || `Session ${s.sessionNumber}`,
    tracks: (s.tracks || []).map((t: any) => ({
      trackNumber: t.trackNumber,
      title: t.title,
      speaker: t.speaker || null,
      language: t.language,
      isTranslation: t.isTranslation,
      originalFilename: t.originalFilename || "",
      file: { name: t.originalFilename || t.title, size: t.fileSizeBytes || 0 } as File,
      date: s.sessionDate || null,
      timePeriod: s.timePeriod || null,
      partNumber: null,
    })),
  }));
}

export const EventEdit = () => {
  const { id } = useParams<{ id: string }>();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const redirect = useRedirect();
  const translate = useTranslate();

  const { data: event, isPending } = useGetOne("events", { id: id! }, { enabled: !!id });

  const [form, setForm] = useState<EventFormData>({ ...EMPTY_FORM });
  const [sessions, setSessions] = useState<InferredSession[]>([]);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

    if (event.sessions) {
      setSessions(toInferredSessions(event.sessions));
    }

    setInitialized(true);
  }, [event, allTeachers, allPlaces, allGroups, allEventTypes, allAudiences, lookupsLoaded, initialized]);

  const handleSessionTitleChange = useCallback(
    (idx: number, title: string) => {
      setSessions((prev) => prev.map((s, i) => (i === idx ? { ...s, titleEn: title } : s)));
    },
    [],
  );

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
        sessions={sessions} onSessionTitleChange={handleSessionTitleChange}
        trackCount={trackCount}
      />

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
