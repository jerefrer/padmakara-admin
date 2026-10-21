import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Checkbox from "@mui/material/Checkbox";
import Alert from "@mui/material/Alert";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import LinearProgress from "@mui/material/LinearProgress";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import MuiTextField from "@mui/material/TextField";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import LibraryBooksIcon from "@mui/icons-material/LibraryBooks";
import { Link as RouterLink } from "react-router-dom";
import { useLocaleState, useNotify, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";
import type {
  EventFormData,
  TeacherOption,
  PlaceOption,
  GroupOption,
  EventTypeOption,
  AudienceOption,
} from "../resources/events";

/* ───────────── Server shapes (src/routes/admin/library.ts) ───────────── */

interface LibraryRecordSummary {
  wixId: string;
  eventCode: string | null;
  title: string;
  teacherNames: string;
  guestName: string;
  organization: string;
  place: string;
  designation: string;
  dateRange: string;
  startDate: string | null;
  endDate: string | null;
}

type MatchReason =
  | { kind: "wixId" }
  | { kind: "code" }
  | { kind: "date"; detail: "same" | "overlap" | "close" | "month" }
  | { kind: "teacher"; detail: string }
  | { kind: "place"; detail: string }
  | { kind: "title"; detail: number };

interface Suggestion extends LibraryRecordSummary {
  score: number;
  reasons: MatchReason[];
}

interface Named { id: number; nameEn: string; namePt: string | null }

interface Mapping {
  wixId: string;
  fields: {
    titlePt: string | null;
    startDate: string | null;
    endDate: string | null;
    mainThemesPt: string | null;
    mainThemesEn: string | null;
    sessionThemesPt: string | null;
    sessionThemesEn: string | null;
    bibliography: string | null;
    organizer: string | null;
    eventTypeId: number | null;
    audienceId: number | null;
    groupIds: number[];
    teacherIds: { id: number; role: "teacher" | "guest" }[];
    placeIds: number[];
    wixId: string;
    librarySnapshot: Record<string, unknown>;
  };
  resolved: {
    eventType: Named | null;
    audience: Named | null;
    groups: Named[];
    teachers: { id: number; name: string; abbreviation: string; role: "teacher" | "guest" }[];
    places: { id: number; name: string; abbreviation: string | null }[];
  };
  unresolved: {
    teachers: { name: string; role: "teacher" | "guest" }[];
    places: string[];
    designation: string | null;
    audience: string | null;
  };
}

/** A suggestion at or above this score is pre-selected when the dialog opens. */
const PRESELECT_SCORE = 50;

type FieldKey =
  | "titlePt" | "startDate" | "endDate" | "mainThemesPt" | "mainThemesEn"
  | "sessionThemesPt" | "sessionThemesEn"
  | "bibliography" | "organizer" | "eventType" | "audience" | "groups"
  | "teachers" | "places";

interface Row {
  key: FieldKey;
  label: string;
  current: string;
  incoming: string;
}

/* ───────────── Props ───────────── */

export interface LibraryMetadataButtonProps {
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
  allGroups: GroupOption[];
  allEventTypes: EventTypeOption[];
  allAudiences: AudienceOption[];
  /** Saved event id (edit view); undefined while the event is still a draft. */
  eventId?: number;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? body?.error ?? body?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const postJson = <T,>(url: string, data: unknown) =>
  getJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

/* ───────────── Button + linked caption ───────────── */

export const LibraryMetadataButton = (props: LibraryMetadataButtonProps) => {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  const { form, setForm } = props;
  const snapshotCode = (form.librarySnapshot?.eventCode as string | null | undefined) ?? null;

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", mb: 2 }}>
      <Button
        size="small"
        variant="outlined"
        startIcon={<LibraryBooksIcon sx={{ fontSize: 16 }} />}
        onClick={() => setOpen(true)}
      >
        {translate("padmakara.library.button")}
      </Button>
      {form.wixId && (
        <>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {translate("padmakara.library.linked", { code: snapshotCode ?? form.wixId })}
          </Typography>
          <Button
            size="small"
            color="inherit"
            sx={{ minWidth: 0, textTransform: "none" }}
            onClick={() => setForm((p) => ({ ...p, wixId: null, librarySnapshot: null }))}
          >
            {translate("padmakara.library.unlink")}
          </Button>
        </>
      )}
      {open && <LibraryMetadataDialog {...props} onClose={() => setOpen(false)} />}
    </Box>
  );
};

/* ───────────── Dialog ───────────── */

const LibraryMetadataDialog = ({
  form, setForm,
  selectedTeachers, setSelectedTeachers,
  selectedPlaces, setSelectedPlaces,
  selectedGroups, setSelectedGroups,
  selectedEventType, setSelectedEventType,
  selectedAudience, setSelectedAudience,
  allGroups, allEventTypes, allAudiences,
  eventId,
  onClose,
}: LibraryMetadataButtonProps & { onClose: () => void }) => {
  const translate = useTranslate();
  const notify = useNotify();
  const [locale] = useLocaleState();
  const pt = locale === "pt";
  const named = (n: { nameEn: string; namePt: string | null } | null | undefined) =>
    n ? (pt ? n.namePt || n.nameEn : n.nameEn) : "";

  const [loaded, setLoaded] = useState(false);
  const [recordCount, setRecordCount] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LibraryRecordSummary[] | null>(null);
  const [selected, setSelected] = useState<LibraryRecordSummary | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [checked, setChecked] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the form holds right now, sent so a draft event is matched on what the
  // admin has typed so far (the server falls back to the saved event's data).
  const draft = useMemo(
    () => ({
      eventId,
      wixId: form.wixId || undefined,
      eventCode: form.eventCode || undefined,
      title: form.titlePt || form.titleEn || undefined,
      startDate: form.startDate || undefined,
      endDate: form.endDate || undefined,
      teacherNames: selectedTeachers.map((t) => t.name),
      placeName: selectedPlaces[0]?.name,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const choose = useCallback(async (record: LibraryRecordSummary) => {
    setSelected(record);
    setMapping(null);
    setMappingLoading(true);
    setError(null);
    try {
      const out = await getJson<{ mapping: Mapping }>(
        `/api/admin/library/records/${encodeURIComponent(record.wixId)}/mapping`,
      );
      setMapping(out.mapping);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMappingLoading(false);
    }
  }, []);

  // Open: record count + best candidates, best one pre-selected.
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await getJson<{ count: number }>("/api/admin/library/status");
        if (cancelled) return;
        setRecordCount(status.count);
        if (status.count > 0) {
          const out = await postJson<{ suggestions: Suggestion[] }>("/api/admin/library/suggest", draft);
          if (cancelled) return;
          setSuggestions(out.suggestions);
          const best = out.suggestions[0];
          if (best && best.score >= PRESELECT_SCORE) void chooseRef.current(best);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [draft]);

  // Live search, debounced.
  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const out = await getJson<{ records: LibraryRecordSummary[] }>(
          `/api/admin/library/records?q=${encodeURIComponent(query)}`,
        );
        if (!cancelled) setResults(out.records);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  /* ── Field-by-field preview ── */

  const rows: Row[] = useMemo(() => {
    if (!mapping) return [];
    const f = mapping.fields;
    const out: Row[] = [];
    const text = (key: FieldKey, label: string, current: string, incoming: string | null) => {
      const inc = (incoming ?? "").trim();
      if (inc && inc !== current.trim()) out.push({ key, label, current, incoming: inc });
    };
    const ev = (k: string) => translate(`padmakara.events.${k}`);
    text("titlePt", ev("titlePt"), form.titlePt, f.titlePt);
    text("startDate", ev("startDate"), form.startDate, f.startDate);
    text("endDate", ev("endDate"), form.endDate, f.endDate);
    text("mainThemesPt", ev("mainThemesPt"), form.mainThemesPt, f.mainThemesPt);
    text("mainThemesEn", ev("mainThemesEn"), form.mainThemesEn, f.mainThemesEn);
    text("sessionThemesPt", ev("sessionThemesPt"), form.sessionThemesPt, f.sessionThemesPt);
    text("sessionThemesEn", ev("sessionThemesEn"), form.sessionThemesEn, f.sessionThemesEn);
    text("bibliography", translate("padmakara.library.bibliography"), form.bibliography, f.bibliography);
    text("organizer", ev("organizer"), form.organizer, f.organizer);

    if (mapping.resolved.eventType) {
      text("eventType", ev("eventType"), named(selectedEventType), named(mapping.resolved.eventType));
    }
    if (mapping.resolved.audience) {
      text("audience", ev("audience"), named(selectedAudience), named(mapping.resolved.audience));
    }
    if (mapping.resolved.groups.length > 0) {
      text(
        "groups",
        ev("retreatGroups"),
        selectedGroups.map(named).join(", "),
        mapping.resolved.groups.map(named).join(", "),
      );
    }

    const guestLabel = translate("padmakara.library.guest");
    const people = [
      ...mapping.resolved.teachers.map((t) => (t.role === "guest" ? `${t.name} (${guestLabel})` : t.name)),
      ...mapping.unresolved.teachers.map(
        (t) => `${t.name}${t.role === "guest" ? ` (${guestLabel})` : ""} (${translate("padmakara.library.new")})`,
      ),
    ];
    text(
      "teachers",
      ev("teachers"),
      selectedTeachers.map((t) => (form.guestTeacherIds.includes(t.id) ? `${t.name} (${guestLabel})` : t.name)).join(", "),
      people.join(", "),
    );

    const placeNames = [
      ...mapping.resolved.places.map((p) => p.name),
      ...mapping.unresolved.places.map((p) => `${p} (${translate("padmakara.library.new")})`),
    ];
    text("places", ev("places"), selectedPlaces.map((p) => p.name).join(", "), placeNames.join(", "));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping, locale]);

  // Default: checked where it fills an empty field, unchecked where it would overwrite.
  useEffect(() => {
    setChecked(Object.fromEntries(rows.map((r) => [r.key, r.current.trim() === ""])));
  }, [rows]);

  const needsNewTeachers = (checked.teachers ?? false) && (mapping?.unresolved.teachers.length ?? 0) > 0;
  const needsNewPlaces = (checked.places ?? false) && (mapping?.unresolved.places.length ?? 0) > 0;

  const apply = async () => {
    if (!mapping) return;
    setApplying(true);
    setError(null);
    try {
      const f = mapping.fields;
      const on = (k: FieldKey) => checked[k] === true && rows.some((r) => r.key === k);

      // Teachers/places the library names but the database lacks are created
      // now (reference data); the event itself is only saved by the form's Save.
      let createdTeachers: { name: string; id: number; abbreviation: string }[] = [];
      let createdPlaces: { location: string; id: number; name: string; abbreviation: string | null }[] = [];
      if (needsNewTeachers || needsNewPlaces) {
        const out = await postJson<{
          teachers: typeof createdTeachers;
          places: typeof createdPlaces;
        }>("/api/admin/library/entities", {
          teachers: needsNewTeachers ? mapping.unresolved.teachers.map((t) => t.name) : [],
          places: needsNewPlaces ? mapping.unresolved.places : [],
        });
        createdTeachers = out.teachers;
        createdPlaces = out.places;
      }

      setForm((prev) => {
        const next: EventFormData = { ...prev };
        // Library text is human-written, so a field it fills counts as reviewed.
        if (on("titlePt")) { next.titlePt = f.titlePt ?? ""; next.titlePtReviewed = true; }
        if (on("startDate")) next.startDate = f.startDate ?? "";
        if (on("endDate")) next.endDate = f.endDate ?? "";
        if (on("mainThemesPt")) { next.mainThemesPt = f.mainThemesPt ?? ""; next.mainThemesPtReviewed = true; }
        if (on("mainThemesEn")) { next.mainThemesEn = f.mainThemesEn ?? ""; next.mainThemesEnReviewed = true; }
        if (on("sessionThemesPt")) { next.sessionThemesPt = f.sessionThemesPt ?? ""; next.sessionThemesPtReviewed = true; }
        if (on("sessionThemesEn")) { next.sessionThemesEn = f.sessionThemesEn ?? ""; next.sessionThemesEnReviewed = true; }
        if (on("bibliography")) next.bibliography = f.bibliography ?? "";
        if (on("organizer")) next.organizer = f.organizer ?? "";
        if (on("teachers")) {
          const guests = [
            ...mapping.resolved.teachers.filter((t) => t.role === "guest").map((t) => t.id),
            ...mapping.unresolved.teachers
              .filter((t) => t.role === "guest")
              .map((t) => createdTeachers.find((c) => c.name === t.name)?.id)
              .filter((id): id is number => id !== undefined),
          ];
          next.guestTeacherIds = guests;
        }
        // The link to the record and the CSV fields without a column of their own.
        next.wixId = f.wixId;
        next.librarySnapshot = f.librarySnapshot;
        return next;
      });

      if (on("eventType")) {
        setSelectedEventType(allEventTypes.find((et) => et.id === f.eventTypeId) ?? selectedEventType);
      }
      if (on("audience")) {
        setSelectedAudience(allAudiences.find((a) => a.id === f.audienceId) ?? selectedAudience);
      }
      if (on("groups")) setSelectedGroups(allGroups.filter((g) => f.groupIds.includes(g.id)));
      if (on("teachers")) {
        const resolved: TeacherOption[] = mapping.resolved.teachers.map((t) => ({
          id: t.id, name: t.name, abbreviation: t.abbreviation,
        }));
        const created: TeacherOption[] = createdTeachers.map((t) => ({
          id: t.id, name: t.name, abbreviation: t.abbreviation,
        }));
        setSelectedTeachers([...resolved, ...created]);
      }
      if (on("places")) {
        const resolved: PlaceOption[] = mapping.resolved.places.map((p) => ({
          id: p.id, name: p.name, abbreviation: p.abbreviation,
        }));
        const created: PlaceOption[] = createdPlaces.map((p) => ({ id: p.id, name: p.name, abbreviation: null }));
        setSelectedPlaces([...resolved, ...created]);
      }

      notify("padmakara.library.applied", { type: "success" });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  /* ── Rendering ── */

  const reasonLabel = (r: MatchReason): string => {
    switch (r.kind) {
      case "wixId": return translate("padmakara.library.reason.wixId");
      case "code": return translate("padmakara.library.reason.code");
      case "date": return translate(`padmakara.library.reason.date_${r.detail}`);
      case "teacher": return `${translate("padmakara.library.reason.teacher")}: ${r.detail}`;
      case "place": return translate("padmakara.library.reason.place");
      case "title": return translate("padmakara.library.reason.title", { percent: r.detail });
    }
  };

  const recordLine = (r: LibraryRecordSummary) =>
    [r.dateRange.replace(" a ", " – "), [r.teacherNames, r.guestName].filter(Boolean).join(" | "), r.place.split(",")[0]]
      .filter(Boolean)
      .join(" · ");

  const listed: (LibraryRecordSummary & { score?: number; reasons?: MatchReason[] })[] =
    results ?? suggestions;
  const best = suggestions[0];

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{translate("padmakara.library.dialogTitle")}</DialogTitle>
      <DialogContent dividers>
        {!loaded && <LinearProgress />}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {loaded && recordCount === 0 && (
          <Alert severity="info">
            {translate("padmakara.library.noneLoaded")}{" "}
            <RouterLink to="/library" onClick={onClose}>{translate("padmakara.library.goUpload")}</RouterLink>
          </Alert>
        )}

        {loaded && !!recordCount && (
          <>
            <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
              {best && best.score >= PRESELECT_SCORE
                ? translate("padmakara.library.bestMatchIntro")
                : translate("padmakara.library.noBestMatch")}
            </Typography>

            <MuiTextField
              fullWidth
              size="small"
              autoFocus={false}
              label={translate("padmakara.library.search")}
              placeholder={translate("padmakara.library.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              sx={{ mb: 1 }}
            />

            <Typography variant="overline" sx={{ color: "text.secondary" }}>
              {results === null
                ? translate("padmakara.library.suggestions")
                : translate("padmakara.library.results", { count: results.length })}
            </Typography>
            <List dense disablePadding sx={{ maxHeight: 220, overflowY: "auto", border: "1px solid", borderColor: "divider", borderRadius: 1, mb: 2 }}>
              {listed.length === 0 && (
                <ListItemText sx={{ px: 2, py: 1 }} secondary={translate("padmakara.library.noMatches")} />
              )}
              {listed.map((r) => (
                <ListItemButton key={r.wixId} selected={selected?.wixId === r.wixId} onClick={() => choose(r)}>
                  <ListItemText
                    primary={r.title || r.eventCode}
                    secondary={
                      <>
                        {recordLine(r)}
                        {r.reasons && (
                          <Box component="span" sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 0.5 }}>
                            {r.score !== undefined && (
                              <Chip size="small" color="primary" label={translate("padmakara.library.score", { score: r.score })} />
                            )}
                            {r.reasons.map((reason, i) => (
                              <Chip key={i} size="small" variant="outlined" label={reasonLabel(reason)} />
                            ))}
                          </Box>
                        )}
                      </>
                    }
                    slotProps={{ secondary: { component: "div" } }}
                  />
                </ListItemButton>
              ))}
            </List>
          </>
        )}

        {mappingLoading && <LinearProgress />}

        {selected && mapping && (
          <>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              {translate("padmakara.library.previewTitle", { title: selected.title || selected.eventCode })}
            </Typography>
            {rows.length === 0 ? (
              <Alert severity="info" sx={{ mb: 1 }}>{translate("padmakara.library.nothingToApply")}</Alert>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell>{translate("padmakara.library.field")}</TableCell>
                    <TableCell>{translate("padmakara.library.current")}</TableCell>
                    <TableCell>{translate("padmakara.library.fromLibrary")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.key} hover>
                      <TableCell padding="checkbox">
                        <Checkbox
                          size="small"
                          checked={checked[r.key] === true}
                          onChange={(e) => setChecked((p) => ({ ...p, [r.key]: e.target.checked }))}
                        />
                      </TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap", verticalAlign: "top" }}>{r.label}</TableCell>
                      <TableCell sx={{ color: "text.secondary", verticalAlign: "top", whiteSpace: "pre-wrap", maxWidth: 240 }}>
                        {r.current.trim() ? clip(r.current) : translate("padmakara.library.empty")}
                      </TableCell>
                      <TableCell sx={{ verticalAlign: "top", whiteSpace: "pre-wrap", maxWidth: 280 }}>{clip(r.incoming)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {(needsNewTeachers || needsNewPlaces) && (
              <Alert severity="warning" sx={{ mt: 1.5 }}>
                {translate("padmakara.library.willCreate")}
              </Alert>
            )}
            {mapping.unresolved.designation && (
              <Alert severity="info" sx={{ mt: 1.5 }}>
                {translate("padmakara.library.unmatchedDesignation", { name: mapping.unresolved.designation })}
              </Alert>
            )}
            {mapping.unresolved.audience && (
              <Alert severity="info" sx={{ mt: 1.5 }}>
                {translate("padmakara.library.unmatchedAudience", { name: mapping.unresolved.audience })}
              </Alert>
            )}
            <Typography variant="caption" sx={{ display: "block", color: "text.secondary", mt: 1.5 }}>
              {translate("padmakara.library.applyNote")}
            </Typography>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={applying}>{translate("padmakara.library.cancel")}</Button>
        <Button variant="contained" disableElevation disabled={!mapping || applying} onClick={apply}>
          {translate("padmakara.library.apply")}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

/** Long themes/bibliography texts are clipped in the preview table. */
function clip(value: string, max = 220): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
