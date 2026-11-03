/**
 * "People with access" card (edit view only): everyone holding a grant on the
 * event, orders still waiting for payment, and a box to give access by hand.
 */

import { useState } from "react";
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
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import GroupIcon from "@mui/icons-material/Group";
import { authFetch } from "../utils/authFetch";
import { formatEuros } from "./EventSaleSection";
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
        placeholder={translate("padmakara.eventAccess.emailsPlaceholder")}
        helperText={translate("padmakara.eventAccess.emailsHelp")}
      />
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
