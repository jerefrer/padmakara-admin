/**
 * Read-only list of the publications an event shows without anyone linking
 * them by hand: texts whose retreat groups include one of the event's groups
 * (set in Publications), plus, separately labelled, legacy direct links.
 * Exists so admins are not tempted to add the same text to the event again.
 */

import { useEffect, useState } from "react";
import { useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { authFetch } from "../utils/authFetch";

interface PublicationSummary {
  id: number;
  title: string;
  language: string;
  version: string | null;
}

interface EventPublications {
  viaGroups: PublicationSummary[];
  direct: PublicationSummary[];
}

interface Props {
  eventId: number;
}

const PublicationList = ({ items }: { items: PublicationSummary[] }) => {
  const translate = useTranslate();
  return (
    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
      {items.map((p) => (
        <li key={p.id}>
          <Link href={`#/publications/${p.id}`} underline="hover">
            {p.title}
          </Link>
          <Typography component="span" variant="caption" sx={{ color: "text.secondary", ml: 1 }}>
            {p.language.toUpperCase()}
            {p.version
              ? ` · ${translate("padmakara.eventPublications.version") || "Version"} ${p.version}`
              : ""}
          </Typography>
        </li>
      ))}
    </Box>
  );
};

export const EventPublicationsPanel = ({ eventId }: Props) => {
  const translate = useTranslate();
  const [data, setData] = useState<EventPublications | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`/api/admin/events/${eventId}/publications`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as EventPublications;
        if (!cancelled) setData(json);
      } catch (err) {
        // Informational panel: a failed load just hides it.
        console.error("Event publications load failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (!data || (data.viaGroups.length === 0 && data.direct.length === 0)) return null;

  return (
    <Paper sx={{ p: 3, mb: 3 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5, fontWeight: 600, color: "text.secondary" }}>
        {translate("padmakara.eventPublications.title") || "Publications for this event's groups"}
      </Typography>
      <Typography variant="body2" sx={{ mb: 1.5, color: "text.secondary" }}>
        {translate("padmakara.eventPublications.hint") ||
          "These texts appear on this event automatically through its retreat groups. To add a text to all events of a group, set its retreat groups in Publications."}
      </Typography>
      {data.viaGroups.length > 0 && <PublicationList items={data.viaGroups} />}
      {data.direct.length > 0 && (
        <Box sx={{ mt: data.viaGroups.length > 0 ? 2 : 0 }}>
          <Typography variant="caption" sx={{ fontWeight: 600, color: "text.secondary" }}>
            {translate("padmakara.eventPublications.direct") || "Linked directly to this event (legacy)"}
          </Typography>
          <PublicationList items={data.direct} />
        </Box>
      )}
    </Paper>
  );
};
