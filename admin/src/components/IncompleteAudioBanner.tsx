import { useCallback, useEffect, useState } from "react";
import { useTranslate } from "react-admin";
import { useLocation, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import { authFetch } from "../utils/authFetch";

interface IncompleteEvent {
  id: number;
  eventCode: string;
  titleEn: string | null;
  titlePt: string | null;
  status: string;
  missing: number;
  total: number;
}

/**
 * Calm, always-present admin banner listing events that still have tracks
 * without audio (s3_key null) — i.e. an upload that never finished. Every
 * track is meant to have audio, so any such event is genuinely incomplete.
 * Clicking "Review" opens a list; published events are emphasised, drafts
 * shown more quietly. Clicking one jumps to its edit page to finish it.
 * Renders nothing when everything is complete.
 */
export const IncompleteAudioBanner = () => {
  const translate = useTranslate();
  const navigate = useNavigate();
  const location = useLocation();
  const [events, setEvents] = useState<IncompleteEvent[]>([]);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  const load = useCallback(() => {
    let cancelled = false;
    authFetch("/api/admin/events/incomplete-audio")
      .then((res) => (res.ok ? res.json() : { events: [] }))
      .then((json: { events?: IncompleteEvent[] }) => {
        if (!cancelled) setEvents(json.events ?? []);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Refetch on every navigation so the banner clears once an event is
  // repaired (finishing an upload navigates/refreshes).
  useEffect(() => load(), [load, location.pathname]);

  if (events.length === 0) return null;

  const rank = (s: string) => (s === "published" ? 0 : s === "draft" ? 1 : 2);
  const ordered = [...events].sort((a, b) => rank(a.status) - rank(b.status));
  const title = (e: IncompleteEvent) => e.titleEn || e.titlePt || e.eventCode;

  return (
    <Box sx={{ px: 2, pt: 2 }}>
      <Alert
        severity="warning"
        variant="outlined"
        sx={{ alignItems: "center" }}
        action={
          <Button color="inherit" size="small" onClick={(e) => setAnchorEl(e.currentTarget)}>
            {translate("padmakara.events.pendingAudioReview")}
          </Button>
        }
      >
        {translate("padmakara.events.pendingAudio", { smart_count: events.length })}
      </Alert>
      <Menu anchorEl={anchorEl} open={!!anchorEl} onClose={() => setAnchorEl(null)}>
        {ordered.map((e) => {
          const published = e.status === "published";
          return (
            <MenuItem
              key={e.id}
              onClick={() => {
                setAnchorEl(null);
                navigate(`/events/${e.id}`);
              }}
              sx={{ gap: 1, py: 1 }}
            >
              <Chip
                label={translate(`padmakara.events.${e.status}`, { _: e.status })}
                size="small"
                color={published ? "error" : "default"}
                variant={published ? "filled" : "outlined"}
              />
              <Typography
                variant="body2"
                sx={{ fontWeight: published ? 700 : 400, flex: 1, opacity: published ? 1 : 0.7 }}
              >
                {title(e)}
              </Typography>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {translate("padmakara.events.audioMissingCount", { missing: e.missing, total: e.total })}
              </Typography>
            </MenuItem>
          );
        })}
      </Menu>
    </Box>
  );
};
