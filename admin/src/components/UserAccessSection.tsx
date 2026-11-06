/**
 * Access section of the user page: only what this person has. Groups and
 * attended events are form fields, so they change with Save like the rest of
 * the page. Bought and given events are managed from the event page.
 */

import { useEffect, useState } from "react";
import { useInput, useLocaleState, useNotify, useRecordContext, useTranslate } from "react-admin";
import Autocomplete, { createFilterOptions } from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import { authFetch } from "../utils/authFetch";

export interface AccessOption {
  id: number;
  label: string;
  /** Second line under the label, and extra search text. */
  detail?: string;
}

interface EventRecord {
  id: number;
  eventCode?: string | null;
  titleEn?: string | null;
  titlePt?: string | null;
  startDate?: string | null;
}

interface GroupRecord {
  id: number;
  nameEn?: string | null;
  namePt?: string | null;
}

interface EventGrant extends EventRecord {
  eventId: number;
  source: string;
  createdAt: string;
  grantedBy: string | null;
}

const titleOf = (r: EventRecord, locale: string): string =>
  (locale === "pt" && r.titlePt ? r.titlePt : r.titleEn) || r.eventCode || "";

const formatDate = (iso: string | null | undefined, locale: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale === "pt" ? "pt-PT" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

export const eventOption = (e: EventRecord, locale: string): AccessOption => ({
  id: e.id,
  label: titleOf(e, locale),
  detail: [formatDate(e.startDate, locale), e.eventCode].filter(Boolean).join(" · "),
});

const filterOptions = createFilterOptions<AccessOption>({
  stringify: (o) => `${o.label} ${o.detail ?? ""}`,
});

const Row = ({ primary, secondary, href, action }: {
  primary: string;
  secondary?: string;
  href?: string;
  action?: React.ReactNode;
}) => (
  <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.75, borderBottom: 1, borderColor: "divider" }}>
    <Box sx={{ flex: 1, minWidth: 0 }}>
      {href ? (
        <Link href={href} underline="hover" variant="body2">{primary}</Link>
      ) : (
        <Typography variant="body2">{primary}</Typography>
      )}
      {secondary && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
          {secondary}
        </Typography>
      )}
    </Box>
    {action}
  </Box>
);

const Heading = ({ children }: { children: React.ReactNode }) => (
  <Typography variant="body2" sx={{ fontWeight: 600, mt: 2.5, mb: 0.5 }}>
    {children}
  </Typography>
);

/** The chosen ids as rows with a remove button, and a search box to add one. */
export const AccessPicker = ({ source, title, options, addLabel, emptyLabel, removeLabel }: {
  source: string;
  title: string;
  options: AccessOption[];
  addLabel: string;
  emptyLabel: string;
  removeLabel: string;
}) => {
  const { field } = useInput({ source });
  const chosen: number[] = Array.isArray(field.value) ? field.value : [];
  const byId = new Map(options.map((o) => [o.id, o]));
  // Remounting clears the search box after each pick.
  const [pickKey, setPickKey] = useState(0);

  return (
    <Box>
      <Heading>{title}</Heading>
      {chosen.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 0.75 }}>{emptyLabel}</Typography>
      )}
      {chosen.map((id) => {
        const option = byId.get(id);
        return (
          <Row
            key={id}
            primary={option?.label ?? `#${id}`}
            secondary={option?.detail}
            action={
              <IconButton
                size="small"
                aria-label={`${removeLabel}: ${option?.label ?? id}`}
                onClick={() => field.onChange(chosen.filter((x) => x !== id))}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            }
          />
        );
      })}
      <Autocomplete
        key={pickKey}
        options={options.filter((o) => !chosen.includes(o.id))}
        filterOptions={filterOptions}
        getOptionLabel={(o) => o.label}
        renderOption={({ key, ...props }, o) => (
          <li key={o.id} {...props}>
            <Box>
              <Typography variant="body2">{o.label}</Typography>
              {o.detail && <Typography variant="caption" color="text.secondary">{o.detail}</Typography>}
            </Box>
          </li>
        )}
        onChange={(_, o) => {
          if (!o) return;
          field.onChange([...chosen, o.id]);
          setPickKey((k) => k + 1);
        }}
        size="small"
        sx={{ mt: 1 }}
        renderInput={(params) => <TextField {...params} placeholder={addLabel} helperText={false} />}
      />
    </Box>
  );
};

export const UserAccessSection = () => {
  const record = useRecordContext();
  const translate = useTranslate();
  const notify = useNotify();
  const [locale] = useLocaleState();
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);

  useEffect(() => {
    const load = async <T,>(url: string, set: (rows: T[]) => void, failed: string) => {
      try {
        const res = await authFetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        set((await res.json()) as T[]);
      } catch {
        notify(translate(failed), { type: "error" });
      }
    };
    load<GroupRecord>("/api/admin/groups?_start=0&_end=100&_sort=displayOrder&_order=ASC", setGroups, "padmakara.users.loadGroupsFailed");
    load<EventRecord>("/api/admin/events?_start=0&_end=500&_sort=startDate&_order=DESC", setEvents, "padmakara.users.loadEventsFailed");
  }, []);

  const groupOptions: AccessOption[] = groups.map((g) => ({
    id: g.id,
    label:
      (locale === "pt" && g.namePt ? g.namePt : g.nameEn) ||
      translate("padmakara.users.groupFallback", { id: g.id }),
  }));
  const eventOptions = events.map((e) => eventOption(e, locale));
  const eventGrants: EventGrant[] = record?.eventGrants ?? [];
  const publications: { id: number; title: string }[] = record?.grantedPublications ?? [];

  const howLabel = (g: EventGrant): string => {
    const when = formatDate(g.createdAt, locale);
    if (g.source === "purchase") return `${translate("padmakara.users.accessBought")} · ${when}`;
    if (g.source === "free") return `${translate("padmakara.eventAccess.freeClaim")} · ${when}`;
    return `${translate("padmakara.eventAccess.givenBy")} ${g.grantedBy ?? ""}`.trim() + ` · ${when}`;
  };

  return (
    <Box sx={{ width: "100%" }}>
      <AccessPicker
        source="retreatGroupIds"
        title={translate("padmakara.users.groups")}
        options={groupOptions}
        addLabel={translate("padmakara.users.addGroup")}
        emptyLabel={translate("padmakara.users.noGroups")}
        removeLabel={translate("ra.action.remove")}
      />
      <AccessPicker
        source="attendedEventIds"
        title={translate("padmakara.users.attendedEvents")}
        options={eventOptions}
        addLabel={translate("padmakara.users.addEvent")}
        emptyLabel={translate("padmakara.users.noAttendedEvents")}
        removeLabel={translate("ra.action.remove")}
      />
      <Heading>{translate("padmakara.users.boughtOrGiven")}</Heading>
      {eventGrants.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 0.75 }}>
          {translate("padmakara.users.noBoughtOrGiven")}
        </Typography>
      )}
      {eventGrants.map((g) => (
        <Row
          key={g.eventId}
          primary={titleOf(g, locale)}
          secondary={howLabel(g)}
          href={`#/events/${g.eventId}`}
        />
      ))}
      {publications.length > 0 && (
        <>
          <Heading>{translate("padmakara.users.givenPublications")}</Heading>
          {publications.map((p) => (
            <Row key={p.id} primary={p.title} href={`#/publications/${p.id}`} />
          ))}
        </>
      )}
    </Box>
  );
};
