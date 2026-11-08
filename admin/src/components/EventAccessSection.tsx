/**
 * "People with access" card (edit view only): everyone holding a grant on the
 * event, orders still waiting for payment, and a box to give access by hand.
 */

import { useEffect, useState, type KeyboardEvent } from "react";
import { useNotify, useTranslate } from "react-admin";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import GroupIcon from "@mui/icons-material/Group";
import { authFetch } from "../utils/authFetch";
import { formatEuros } from "./EventAccessChooser";
import type { AccessGrant, EventAccess } from "./useEventAccess";

interface Props {
  eventId: number;
  access: EventAccess | null;
  reload: () => void;
}

interface GiveResult {
  added: string[];
  alreadyHad: string[];
  invalid: string[];
}

interface Suggestion {
  id: number;
  email: string;
  name: string;
}

const MIN_SEARCH_CHARS = 2;
const MAX_SUGGESTIONS = 8;
const SEARCH_DEBOUNCE_MS = 250;

const METHOD_LABELS: Record<string, string> = { mb: "Multibanco", mbw: "MB WAY", cc: "Card" };

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
};

export const EventAccessSection = ({ eventId, access, reload }: Props) => {
  const translate = useTranslate();
  const notify = useNotify();
  const [emailsText, setEmailsText] = useState("");
  const [notifyThem, setNotifyThem] = useState(true);
  const [language, setLanguage] = useState<"pt" | "en">("pt");
  const [giving, setGiving] = useState(false);
  const [result, setResult] = useState<GiveResult | null>(null);
  const [toRemove, setToRemove] = useState<AccessGrant | null>(null);

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);

  // Look up existing accounts for the line being typed (the last one).
  const currentLine = emailsText.slice(emailsText.lastIndexOf("\n") + 1).trim();
  useEffect(() => {
    setSuggestions([]);
    setActiveIndex(-1);
    if (currentLine.length < MIN_SEARCH_CHARS) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        // Ask for a few extra rows so accounts already in the box can be dropped.
        const params = new URLSearchParams({
          q: currentLine,
          _start: "0",
          _end: String(MAX_SUGGESTIONS * 2),
          _sort: "email",
          _order: "ASC",
        });
        const res = await authFetch(`/api/admin/users?${params}`);
        if (!res.ok) return;
        const rows = (await res.json()) as { id: number; email: string; firstName?: string | null; lastName?: string | null }[];
        if (cancelled) return;
        const listed = new Set(emailsText.split("\n").slice(0, -1).map((e) => e.trim().toLowerCase()));
        setSuggestions(
          rows
            .filter((u) => !listed.has(u.email.toLowerCase()))
            .slice(0, MAX_SUGGESTIONS)
            .map((u) => ({ id: u.id, email: u.email, name: [u.firstName, u.lastName].filter(Boolean).join(" ") })),
        );
      } catch {
        // Suggestions are a convenience; typing still works without them.
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // emailsText is read for the lines above the current one; the current line drives the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailsText]);

  const pickSuggestion = (s: Suggestion) => {
    const head = emailsText.slice(0, emailsText.lastIndexOf("\n") + 1);
    setEmailsText(`${head}${s.email}\n`);
  };

  const handleEmailsKeyDown = (e: KeyboardEvent) => {
    if (suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      pickSuggestion(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      setSuggestions([]);
    }
  };

  const how = (g: AccessGrant): string => {
    if (g.source === "purchase") {
      const method = g.method ? METHOD_LABELS[g.method] ?? g.method.toUpperCase() : null;
      const paid = `${translate("padmakara.eventAccess.paid")} ${g.amountCents != null ? formatEuros(g.amountCents).replace(/\.00$/, "") : ""}`.trim();
      return method ? `${paid} · ${method}` : paid;
    }
    if (g.source === "free") return translate("padmakara.eventAccess.freeClaim");
    const by = g.grantedBy ? g.grantedBy.name || g.grantedBy.email || "" : "";
    return `${translate("padmakara.eventAccess.givenBy")} ${by}`.trim();
  };

  const handleGive = async () => {
    const emails = emailsText.split("\n").map((e) => e.trim()).filter(Boolean);
    if (emails.length === 0) return;
    setGiving(true);
    try {
      const res = await authFetch(`/api/admin/events/${eventId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails, notify: notifyThem, language }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setResult((await res.json()) as GiveResult);
      setEmailsText("");
      reload();
    } catch (err: any) {
      notify(translate("padmakara.eventAccess.giveFailed", { message: err?.message ?? String(err) }), { type: "error" });
    } finally {
      setGiving(false);
    }
  };

  const handleRemove = async () => {
    const target = toRemove;
    setToRemove(null);
    if (!target) return;
    try {
      const res = await authFetch(`/api/admin/events/${eventId}/access/${target.userId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      reload();
    } catch (err: any) {
      notify(translate("padmakara.eventAccess.removeFailed", { message: err?.message ?? String(err) }), { type: "error" });
    }
  };

  const grants = access?.grants ?? [];
  const pending = access?.pendingOrders ?? [];

  return (
    <Paper sx={{ p: 3, mb: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
        <GroupIcon sx={{ color: "primary.main" }} />
        <Typography variant="h6" sx={{ lineHeight: 1.3 }}>
          {translate("padmakara.eventAccess.title")}
        </Typography>
      </Box>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
        {translate("padmakara.eventAccess.subtitle")}
      </Typography>

      {grants.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
          {translate("padmakara.eventAccess.empty")}
        </Typography>
      ) : (
        <Box sx={{ mb: 2 }}>
          {grants.map((g) => (
            <Box
              key={g.userId}
              sx={{ display: "flex", alignItems: "center", gap: 2, py: 0.75, borderBottom: "1px solid", borderColor: "divider" }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{g.name || g.email}</Typography>
                {g.name && <Typography variant="caption" sx={{ color: "text.secondary" }}>{g.email}</Typography>}
              </Box>
              <Typography variant="body2" sx={{ flex: 1 }}>{how(g)}</Typography>
              <Typography variant="caption" sx={{ color: "text.secondary", width: 80 }}>{formatDate(g.createdAt)}</Typography>
              <IconButton
                size="small"
                aria-label={translate("padmakara.eventAccess.remove")}
                onClick={() => setToRemove(g)}
              >
                <DeleteOutlineIcon fontSize="small" sx={{ color: "primary.main" }} />
              </IconButton>
            </Box>
          ))}
        </Box>
      )}

      {pending.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="caption" sx={{ fontWeight: 600, color: "text.secondary" }}>
            {translate("padmakara.eventAccess.pending")}
          </Typography>
          {pending.map((o) => (
            <Box key={o.id} sx={{ display: "flex", gap: 2, py: 0.5 }}>
              <Typography variant="body2" sx={{ flex: 1 }}>{o.name ? `${o.name} · ${o.email}` : o.email}</Typography>
              <Typography variant="body2">{formatEuros(o.amountCents)}</Typography>
              <Typography variant="caption" sx={{ color: "text.secondary", width: 80 }}>{formatDate(o.createdAt)}</Typography>
            </Box>
          ))}
        </Box>
      )}

      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
        {translate("padmakara.eventAccess.giveTitle")}
      </Typography>
      <TextField
        multiline
        minRows={3}
        fullWidth
        value={emailsText}
        onChange={(e) => setEmailsText(e.target.value)}
        onKeyDown={handleEmailsKeyDown}
        placeholder={translate("padmakara.eventAccess.emailsPlaceholder")}
        helperText={translate("padmakara.eventAccess.emailsHelp")}
      />
      {suggestions.length > 0 && (
        <Paper variant="outlined" sx={{ mt: 0.5 }}>
          <List dense disablePadding role="listbox">
            {suggestions.map((s, i) => (
              <ListItemButton
                key={s.id}
                role="option"
                selected={i === activeIndex}
                aria-selected={i === activeIndex}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickSuggestion(s)}
              >
                <ListItemText primary={s.name || s.email} secondary={s.name ? s.email : undefined} />
              </ListItemButton>
            ))}
          </List>
        </Paper>
      )}
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap", mt: 1 }}>
        <FormControlLabel
          control={<Checkbox checked={notifyThem} onChange={(_, c) => setNotifyThem(c)} />}
          label={translate("padmakara.eventAccess.emailThem")}
        />
        <TextField
          select
          size="small"
          label={translate("padmakara.eventAccess.language")}
          value={language}
          onChange={(e) => setLanguage(e.target.value as "pt" | "en")}
          sx={{ width: 150 }}
        >
          <MenuItem value="pt">Português</MenuItem>
          <MenuItem value="en">English</MenuItem>
        </TextField>
        <Button variant="contained" disabled={giving || !emailsText.trim()} onClick={handleGive}>
          {translate("padmakara.eventAccess.give")}
        </Button>
      </Box>

      {result && (
        <Alert severity={result.invalid.length > 0 ? "warning" : "success"} sx={{ mt: 2 }} onClose={() => setResult(null)}>
          <div>{translate("padmakara.eventAccess.resultAdded", { count: result.added.length })}</div>
          <div>{translate("padmakara.eventAccess.resultAlreadyHad", { count: result.alreadyHad.length })}</div>
          {result.invalid.length > 0 && (
            <div>{translate("padmakara.eventAccess.resultInvalid", { emails: result.invalid.join(", ") })}</div>
          )}
        </Alert>
      )}

      <Dialog open={toRemove !== null} onClose={() => setToRemove(null)}>
        <DialogTitle>{translate("padmakara.eventAccess.removeTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {translate("padmakara.eventAccess.removeBody", { email: toRemove?.email ?? "" })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setToRemove(null)}>{translate("padmakara.eventAccess.cancel")}</Button>
          <Button color="error" onClick={handleRemove}>{translate("padmakara.eventAccess.confirmRemove")}</Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
};
