/**
 * Add people to a list by pasting emails, and see or remove who is on it. Used for
 * the participants of an event and the members of a user group: the endpoint and the
 * i18n prefix are the only difference. Accounts are created for emails that have none
 * and nobody is emailed, so the result lists the new accounts to check for typos.
 */

import { useState } from "react";
import { useNotify, useTranslate } from "react-admin";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import GroupIcon from "@mui/icons-material/Group";
import { ConfirmChangeDialog } from "./ConfirmChangeDialog";
import { useBatchMembers, type BatchAddResult, type BatchMember } from "./useBatchMembers";

/** More people than this and the list gets a filter box. */
const FILTER_THRESHOLD = 10;

interface Props {
  /** e.g. /api/admin/events/12/participants */
  endpoint: string;
  /** e.g. padmakara.participants or padmakara.groupMembers */
  i18nPrefix: string;
}

/** Split pasted text on newlines, commas, semicolons, tabs and spaces (a spreadsheet row or column works). */
export function splitEmails(text: string): string[] {
  return text.split(/[\s,;]+/).filter(Boolean);
}

export const BatchMembersCard = ({ endpoint, i18nPrefix }: Props) => {
  const translate = useTranslate();
  const notify = useNotify();
  const t = (key: string, options?: Record<string, unknown>) => translate(`${i18nPrefix}.${key}`, options);
  const { members, add, remove } = useBatchMembers(endpoint);

  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<BatchAddResult | null>(null);
  const [filter, setFilter] = useState("");
  const [toRemove, setToRemove] = useState<BatchMember | null>(null);

  const handleAdd = async () => {
    const emails = splitEmails(text);
    if (emails.length === 0) return;
    setAdding(true);
    try {
      setResult(await add(emails));
      setText("");
    } catch (err: any) {
      notify(t("addFailed", { message: err?.message ?? String(err) }), { type: "error" });
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async () => {
    const target = toRemove;
    setToRemove(null);
    if (!target) return;
    try {
      await remove(target.id);
    } catch (err: any) {
      notify(t("removeFailed", { message: err?.message ?? String(err) }), { type: "error" });
    }
  };

  const list = members ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? list.filter((m) => m.email.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle))
    : list;
  const pending = splitEmails(text).length;

  return (
    <Paper sx={{ p: 3, mb: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
        <GroupIcon sx={{ color: "primary.main" }} />
        <Typography variant="h6" sx={{ lineHeight: 1.3 }}>
          {t("title")}
        </Typography>
      </Box>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
        {t("subtitle")}
      </Typography>

      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
        {t("addTitle")}
      </Typography>
      <TextField
        multiline
        minRows={3}
        fullWidth
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("emailsPlaceholder")}
        helperText={t("emailsHelp")}
        slotProps={{ htmlInput: { "aria-label": t("addTitle") } }}
      />
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mt: 1 }}>
        <Button variant="contained" disabled={adding || pending === 0} onClick={handleAdd}>
          {pending > 0 ? t("addCount", { count: pending }) : t("add")}
        </Button>
      </Box>

      {result && (
        <Alert severity={result.invalid.length > 0 ? "warning" : "success"} sx={{ mt: 2 }} onClose={() => setResult(null)}>
          <div>{t("resultAdded", { count: result.added.length })}</div>
          <div>{t("resultAlreadyHad", { count: result.alreadyHad.length })}</div>
          {result.created.length > 0 && (
            <Box sx={{ color: "warning.dark", mt: 0.5 }} data-testid="batch-created">
              <div>{t("resultCreated", { count: result.created.length })}</div>
              <div>{result.created.join(", ")}</div>
              <div>{t("resultCreatedHint")}</div>
            </Box>
          )}
          {result.invalid.length > 0 && <div>{t("resultInvalid", { emails: result.invalid.join(", ") })}</div>}
        </Alert>
      )}

      <Box sx={{ mt: 3 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
          {t("listTitle", { count: list.length })}
        </Typography>
        {list.length > FILTER_THRESHOLD && (
          <TextField
            size="small"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("filterPlaceholder")}
            sx={{ mb: 1, width: 280 }}
            slotProps={{ htmlInput: { "aria-label": t("filterPlaceholder") } }}
          />
        )}
        {list.length === 0 ? (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("empty")}
          </Typography>
        ) : (
          shown.map((m) => (
            <Box
              key={m.id}
              sx={{ display: "flex", alignItems: "center", gap: 2, py: 0.75, borderBottom: "1px solid", borderColor: "divider" }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{m.name || m.email}</Typography>
                {m.name && <Typography variant="caption" sx={{ color: "text.secondary" }}>{m.email}</Typography>}
              </Box>
              <IconButton size="small" aria-label={t("remove")} onClick={() => setToRemove(m)}>
                <DeleteOutlineIcon fontSize="small" sx={{ color: "primary.main" }} />
              </IconButton>
            </Box>
          ))
        )}
      </Box>

      <ConfirmChangeDialog
        open={toRemove !== null}
        title={t("removeTitle")}
        message={t("removeBody", { email: toRemove?.email ?? "" })}
        confirmLabel={t("confirmRemove")}
        onConfirm={handleRemove}
        onCancel={() => setToRemove(null)}
      />
    </Paper>
  );
};
