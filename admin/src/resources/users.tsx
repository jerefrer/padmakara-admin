import { useState, useEffect, useCallback, useMemo } from "react";
import {
  List,
  Datagrid,
  TextField,
  EmailField,
  DateField,
  BooleanField,
  Edit,
  SimpleForm,
  TextInput,
  SelectInput,
  BooleanInput,
  DateTimeInput,
  EditButton,
  useTranslate,
  useLocaleState,
  useRecordContext,
  useRefresh,
  useNotify,
} from "react-admin";
import {
  Typography,
  Divider,
  Box,
  Stack,
  FormControlLabel,
  Checkbox,
  Autocomplete,
  TextField as MuiTextField,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  Chip,
  TableContainer,
} from "@mui/material";

import { authFetch as baseAuthFetch } from "../utils/authFetch";

const API_URL = "/api/admin";

const authFetch = (url: string, options: RequestInit = {}) =>
  baseAuthFetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

// ─── List ────────────────────────────────────────────────────────────────────

export const UserList = () => {
  const translate = useTranslate();
  return (
    <List sort={{ field: "createdAt", order: "DESC" }} perPage={100} pagination={false}>
      <Datagrid rowClick="edit">
        <EmailField source="email" label={translate("padmakara.fields.email")} />
        <TextField source="firstName" label={translate("padmakara.fields.firstName")} />
        <TextField source="lastName" label={translate("padmakara.fields.lastName")} />
        <TextField source="dharmaName" label={translate("padmakara.fields.dharmaName")} />
        <TextField source="role" label={translate("padmakara.fields.role")} />
        <BooleanField source="isActive" label={translate("padmakara.fields.isActive")} />
        <TextField source="subscriptionStatus" label={translate("padmakara.users.subscription")} />
        <DateField source="lastActivity" label={translate("padmakara.fields.lastActivity")} showTime />
        <EditButton />
      </Datagrid>
    </List>
  );
};

// ─── Group checkboxes ────────────────────────────────────────────────────────

function GroupCheckboxes() {
  const record = useRecordContext();
  const translate = useTranslate();
  const [locale] = useLocaleState();
  const refresh = useRefresh();
  const notify = useNotify();
  const [allGroups, setAllGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

  const memberGroupIds = new Set(
    (record?.groupMemberships || []).map((m: any) => m.retreatGroupId),
  );

  useEffect(() => {
    authFetch(`${API_URL}/groups?_start=0&_end=100&_sort=displayOrder&_order=ASC`)
      .then((r) => r.json())
      .then(setAllGroups)
      .catch(() => notify(translate("padmakara.users.loadGroupsFailed"), { type: "error" }))
      .finally(() => setLoading(false));
  }, []);

  const toggle = useCallback(
    async (groupId: number, checked: boolean) => {
      if (!record?.id) return;
      setBusy(groupId);
      try {
        if (checked) {
          await authFetch(`${API_URL}/users/${record.id}/groups`, {
            method: "POST",
            body: JSON.stringify({ retreatGroupId: groupId }),
          });
        } else {
          await authFetch(`${API_URL}/users/${record.id}/groups/${groupId}`, {
            method: "DELETE",
          });
        }
        refresh();
      } catch {
        notify(translate("padmakara.users.updateGroupMembershipFailed"), { type: "error" });
      } finally {
        setBusy(null);
      }
    },
    [record?.id, refresh, notify],
  );

  if (loading) return <CircularProgress size={20} />;
  if (allGroups.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        {translate("padmakara.users.noGroupsDefined")}
      </Typography>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column" }}>
      {allGroups.map((g: any) => (
        <FormControlLabel
          key={g.id}
          control={
            <Checkbox
              checked={memberGroupIds.has(g.id)}
              disabled={busy === g.id}
              onChange={(_, checked) => toggle(g.id, checked)}
              size="small"
            />
          }
          label={
            (locale === "pt" && g.namePt ? g.namePt : g.nameEn) ||
            translate("padmakara.users.groupFallback", { id: g.id })
          }
        />
      ))}
    </Box>
  );
}

// ─── Event attendance ────────────────────────────────────────────────────────

type AttendanceSortField = "title" | "startDate" | "eventType" | "status";
type SortDir = "asc" | "desc";

const StatusChip = ({ status }: { status: string }) => {
  const translate = useTranslate();
  const colorMap: Record<string, "success" | "warning" | "default"> = {
    published: "success",
    draft: "warning",
    archived: "default",
  };
  return (
    <Chip
      label={translate(`padmakara.events.${status}`, { _: status })}
      size="small"
      color={colorMap[status] ?? "default"}
      sx={{ fontWeight: 600, textTransform: "capitalize", color: "#fff" }}
    />
  );
};

function EventAttendance() {
  const record = useRecordContext();
  const translate = useTranslate();
  const [locale] = useLocaleState();
  const refresh = useRefresh();
  const notify = useNotify();
  const [allEvents, setAllEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<AttendanceSortField>("startDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filterEventType, setFilterEventType] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | null>(null);

  const attendedIds = useMemo(
    () => new Set((record?.eventAttendance || []).map((a: any) => a.eventId)),
    [record?.eventAttendance],
  );

  useEffect(() => {
    authFetch(`${API_URL}/events?_start=0&_end=500&_sort=startDate&_order=DESC`)
      .then((r) => r.json())
      .then(setAllEvents)
      .catch(() => notify(translate("padmakara.users.loadEventsFailed"), { type: "error" }))
      .finally(() => setLoading(false));
  }, []);

  const toggleAttendance = useCallback(
    async (eventId: number, attended: boolean) => {
      if (!record?.id) return;
      setBusy(eventId);
      try {
        if (attended) {
          await authFetch(`${API_URL}/users/${record.id}/events`, {
            method: "POST",
            body: JSON.stringify({ eventId }),
          });
        } else {
          await authFetch(`${API_URL}/users/${record.id}/events/${eventId}`, {
            method: "DELETE",
          });
        }
        refresh();
      } catch {
        notify(translate("padmakara.users.updateAttendanceFailed"), { type: "error" });
      } finally {
        setBusy(null);
      }
    },
    [record?.id, refresh, notify],
  );

  const handleSort = (field: AttendanceSortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "startDate" ? "desc" : "asc");
    }
  };

  // Collect unique event types for the filter
  const eventTypes = useMemo(() => {
    const map = new Map<number, string>();
    for (const e of allEvents) {
      if (e.eventType) {
        map.set(
          e.eventType.id,
          locale === "pt" && e.eventType.namePt ? e.eventType.namePt : e.eventType.nameEn,
        );
      }
    }
    return Array.from(map, ([id, name]) => ({ id, name }));
  }, [allEvents, locale]);

  // Filter and sort
  const filtered = useMemo(() => {
    let list = allEvents;

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (e) =>
          (e.titleEn || "").toLowerCase().includes(q) ||
          (e.eventCode || "").toLowerCase().includes(q) ||
          (e.eventTeachers || []).some((et: any) =>
            (et.teacher?.name || "").toLowerCase().includes(q) ||
            (et.teacher?.abbreviation || "").toLowerCase().includes(q),
          ),
      );
    }

    if (filterEventType !== null) {
      list = list.filter((e) => e.eventType?.id === filterEventType);
    }

    if (filterStatus) {
      list = list.filter((e) => e.status === filterStatus);
    }

    const mul = sortDir === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => {
      switch (sortField) {
        case "title":
          return mul * (a.titleEn || "").localeCompare(b.titleEn || "");
        case "eventType":
          return mul * (a.eventType?.nameEn || "").localeCompare(b.eventType?.nameEn || "");
        case "status":
          return mul * (a.status || "").localeCompare(b.status || "");
        case "startDate":
        default:
          return mul * (a.startDate || "").localeCompare(b.startDate || "");
      }
    });

    return list;
  }, [allEvents, search, filterEventType, filterStatus, sortField, sortDir]);

  if (loading) return <CircularProgress size={20} />;

  const attendedCount = allEvents.filter((e) => attendedIds.has(e.id)).length;

  return (
    <Box sx={{ width: "100%" }}>
      {/* Filters row */}
      <Stack direction="row" spacing={1} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
        <MuiTextField
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={translate("padmakara.users.searchEventsPlaceholder")}
          variant="outlined"
          size="small"
          sx={{ minWidth: 200, flex: 1 }}
        />
        <Autocomplete
          options={eventTypes}
          getOptionLabel={(o) => o.name}
          value={eventTypes.find((et) => et.id === filterEventType) ?? null}
          onChange={(_, v) => setFilterEventType(v?.id ?? null)}
          size="small"
          sx={{ minWidth: 160 }}
          renderInput={(params) => (
            <MuiTextField {...params} placeholder={translate("padmakara.events.eventType")} variant="outlined" />
          )}
        />
        <Autocomplete
          options={[
            { id: "draft", label: translate("padmakara.events.draft") },
            { id: "published", label: translate("padmakara.events.published") },
            { id: "archived", label: translate("padmakara.events.archived") },
          ]}
          getOptionLabel={(o) => o.label}
          value={
            filterStatus
              ? { id: filterStatus, label: translate(`padmakara.events.${filterStatus}`) }
              : null
          }
          onChange={(_, v) => setFilterStatus(v?.id ?? null)}
          size="small"
          sx={{ minWidth: 130 }}
          renderInput={(params) => (
            <MuiTextField {...params} placeholder={translate("padmakara.events.status")} variant="outlined" />
          )}
        />
        <Chip
          label={translate("padmakara.users.attendedCount", { attended: attendedCount, total: allEvents.length })}
          size="small"
          variant="outlined"
          sx={{ alignSelf: "center" }}
        />
      </Stack>

      {/* Events table */}
      <TableContainer sx={{ maxHeight: 500 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox" sx={{ width: 42 }}>
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                  {translate("padmakara.users.colAtt")}
                </Typography>
              </TableCell>
              <TableCell sortDirection={sortField === "title" ? sortDir : false}>
                <TableSortLabel
                  active={sortField === "title"}
                  direction={sortField === "title" ? sortDir : "asc"}
                  onClick={() => handleSort("title")}
                >
                  {translate("padmakara.users.colEvent")}
                </TableSortLabel>
              </TableCell>
              <TableCell sortDirection={sortField === "eventType" ? sortDir : false}>
                <TableSortLabel
                  active={sortField === "eventType"}
                  direction={sortField === "eventType" ? sortDir : "asc"}
                  onClick={() => handleSort("eventType")}
                >
                  {translate("padmakara.users.colType")}
                </TableSortLabel>
              </TableCell>
              <TableCell>{translate("padmakara.users.colGroups")}</TableCell>
              <TableCell>{translate("padmakara.events.teachers")}</TableCell>
              <TableCell sortDirection={sortField === "startDate" ? sortDir : false} sx={{ whiteSpace: "nowrap" }}>
                <TableSortLabel
                  active={sortField === "startDate"}
                  direction={sortField === "startDate" ? sortDir : "desc"}
                  onClick={() => handleSort("startDate")}
                >
                  {translate("padmakara.users.colDate")}
                </TableSortLabel>
              </TableCell>
              <TableCell sortDirection={sortField === "status" ? sortDir : false}>
                <TableSortLabel
                  active={sortField === "status"}
                  direction={sortField === "status" ? sortDir : "asc"}
                  onClick={() => handleSort("status")}
                >
                  {translate("padmakara.events.status")}
                </TableSortLabel>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filtered.map((event: any) => {
              const attended = attendedIds.has(event.id);
              const isBusy = busy === event.id;
              return (
                <TableRow
                  key={event.id}
                  hover
                  sx={{
                    bgcolor: attended ? "rgba(46, 125, 50, 0.04)" : undefined,
                    opacity: isBusy ? 0.5 : 1,
                  }}
                >
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={attended}
                      disabled={isBusy}
                      onChange={(_, checked) => toggleAttendance(event.id, checked)}
                      size="small"
                    />
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
                      <Typography
                        variant="caption"
                        sx={{ fontFamily: "monospace", fontSize: "0.65rem", opacity: 0.5, fontWeight: 500 }}
                      >
                        {event.eventCode}
                      </Typography>
                      <Typography variant="body2" sx={{ fontSize: "0.8rem" }}>
                        {locale === "pt" && event.titlePt ? event.titlePt : event.titleEn}
                      </Typography>
                    </Box>
                  </TableCell>
                  <TableCell>
                    {event.eventType ? (
                      <Chip
                        label={
                          locale === "pt" && event.eventType.namePt
                            ? event.eventType.namePt
                            : event.eventType.nameEn
                        }
                        size="small"
                      />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                      {(event.eventRetreatGroups || []).map((eg: any) => (
                        <Chip
                          key={eg.retreatGroupId}
                          label={
                            eg.retreatGroup?.abbreviation ||
                            (locale === "pt" && eg.retreatGroup?.namePt
                              ? eg.retreatGroup.namePt
                              : eg.retreatGroup?.nameEn)
                          }
                          size="small"
                          variant="outlined"
                        />
                      ))}
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                      {(event.eventTeachers || []).map((et: any) => (
                        <Chip
                          key={et.teacherId}
                          label={et.teacher?.abbreviation || et.teacher?.name}
                          size="small"
                          variant="outlined"
                        />
                      ))}
                    </Box>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: "nowrap", fontSize: "0.8rem" }}>
                    {event.startDate
                      ? new Date(event.startDate).toLocaleDateString(locale === "pt" ? "pt-PT" : "en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <StatusChip status={event.status} />
                  </TableCell>
                </TableRow>
              );
            })}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} align="center" sx={{ py: 3, color: "text.secondary" }}>
                  {translate("padmakara.users.noEventsFound")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

// ─── Edit ────────────────────────────────────────────────────────────────────

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <Typography variant="subtitle1" fontWeight={600} sx={{ mt: 2, mb: 1 }}>
    {children}
  </Typography>
);

export const UserEdit = () => {
  const translate = useTranslate();
  return (
    <Edit mutationMode="pessimistic">
      <SimpleForm warnWhenUnsavedChanges>
        {/* ─── Identity ──────────────────────────────── */}
        <TextInput source="email" label={translate("padmakara.fields.email")} disabled fullWidth />
        <Stack direction="row" spacing={2} sx={{ width: "100%" }}>
          <TextInput source="firstName" label={translate("padmakara.fields.firstName")} sx={{ flex: 1 }} />
          <TextInput source="lastName" label={translate("padmakara.fields.lastName")} sx={{ flex: 1 }} />
          <TextInput source="dharmaName" label={translate("padmakara.fields.dharmaName")} sx={{ flex: 1 }} />
        </Stack>

        {/* ─── Settings ─────────────────────────────── */}
        <Stack direction="row" spacing={2} sx={{ width: "100%" }}>
          <SelectInput
            source="role"
            label={translate("padmakara.fields.role")}
            choices={[
              { id: "user", name: translate("padmakara.users.roleUser") },
              { id: "admin", name: translate("padmakara.users.roleAdmin") },
            ]}
            sx={{ flex: 1 }}
          />
          <SelectInput
            source="preferredLanguage"
            label={translate("padmakara.fields.preferredLanguage")}
            choices={[
              { id: "en", name: translate("padmakara.users.langEn") },
              { id: "pt", name: translate("padmakara.users.langPt") },
            ]}
            sx={{ flex: 1 }}
          />
        </Stack>
        <Stack direction="row" spacing={4}>
          <BooleanInput source="isActive" label={translate("padmakara.fields.isActive")} />
          <BooleanInput source="isVerified" label={translate("padmakara.fields.isVerified")} />
        </Stack>

        {/* ─── Subscription & Groups (side by side) ─── */}
        <Divider sx={{ width: "100%", my: 1 }} />
        <Box
          sx={{
            width: "100%",
            display: "flex",
            flexWrap: "wrap",
            gap: 3,
          }}
        >
          {/* Subscription column */}
          <Box sx={{ flex: "1 1 400px", minWidth: 0 }}>
            <SectionTitle>{translate("padmakara.users.subscription")}</SectionTitle>
            <Stack spacing={2}>
              <Stack direction="row" spacing={2}>
                <SelectInput
                  source="subscriptionStatus"
                  label={translate("padmakara.users.subscriptionStatusLabel")}
                  choices={[
                    { id: "none", name: translate("padmakara.users.subscriptionNone") },
                    { id: "active", name: translate("padmakara.users.subscriptionActive") },
                    { id: "expired", name: translate("padmakara.users.subscriptionExpired") },
                  ]}
                  sx={{ flex: 1 }}
                />
                <SelectInput
                  source="subscriptionSource"
                  label={translate("padmakara.users.subscriptionSourceLabel")}
                  choices={[
                    { id: "easypay", name: translate("padmakara.users.sourceEasypay") },
                    { id: "cash", name: translate("padmakara.users.sourceCash") },
                    { id: "admin", name: translate("padmakara.users.sourceAdmin") },
                    { id: "bank_transfer", name: translate("padmakara.users.sourceBankTransfer") },
                  ]}
                  parse={(v: string) => v || null}
                  emptyText={translate("padmakara.common.notSet")}
                  sx={{ flex: 1 }}
                />
              </Stack>
              <DateTimeInput
                source="subscriptionExpiresAt"
                label={translate("padmakara.users.subscriptionExpiresAtLabel")}
                fullWidth
              />
              <TextInput
                source="subscriptionNotes"
                label={translate("padmakara.users.subscriptionNotesLabel")}
                multiline
                minRows={3}
                fullWidth
              />
            </Stack>
          </Box>

          {/* Groups column */}
          <Box sx={{ flex: "0 0 auto", minWidth: 180 }}>
            <SectionTitle>{translate("padmakara.users.groups")}</SectionTitle>
            <GroupCheckboxes />
          </Box>
        </Box>

        {/* ─── Event Attendance ──────────────────────── */}
        <Divider sx={{ width: "100%", my: 1 }} />
        <SectionTitle>{translate("padmakara.users.eventAttendance")}</SectionTitle>
        <EventAttendance />
      </SimpleForm>
    </Edit>
  );
};
