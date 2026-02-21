import { useState } from "react";
import {
  List,
  Datagrid,
  TextField,
  EmailField,
  DateField,
  FunctionField,
  useTranslate,
  useRefresh,
  useNotify,
  useRecordContext,
} from "react-admin";
import {
  Chip,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField as MuiTextField,
  Stack,
  CircularProgress,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";

const API_URL = "/api/admin";

const authFetch = (url: string, options: RequestInit = {}) => {
  const token = localStorage.getItem("accessToken");
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
};

// ─── Status Chip ──────────────────────────────────────────────────────────────

const StatusChip = () => {
  const record = useRecordContext();
  if (!record) return null;
  const colorMap: Record<string, "warning" | "success" | "error" | "default"> = {
    pending: "warning",
    approved: "success",
    rejected: "error",
  };
  return (
    <Chip
      label={record.status}
      size="small"
      color={colorMap[record.status] ?? "default"}
      sx={{ fontWeight: 600, textTransform: "capitalize" }}
    />
  );
};

// ─── Action Buttons ───────────────────────────────────────────────────────────

const ApprovalActions = () => {
  const record = useRecordContext();
  const refresh = useRefresh();
  const notify = useNotify();
  const translate = useTranslate();
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [adminMessage, setAdminMessage] = useState("");

  if (!record || record.status !== "pending") return null;

  const handleApprove = async () => {
    setBusy(true);
    try {
      const res = await authFetch(`${API_URL}/approvals/${record.id}/approve`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to approve");
      }
      notify(translate("padmakara.approvals.approvedNotify"), { type: "success" });
      refresh();
    } catch (e: any) {
      notify(e.message, { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setBusy(true);
    try {
      const res = await authFetch(`${API_URL}/approvals/${record.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ adminMessage: adminMessage || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to reject");
      }
      notify(translate("padmakara.approvals.rejectedNotify"), { type: "success" });
      setRejectOpen(false);
      setAdminMessage("");
      refresh();
    } catch (e: any) {
      notify(e.message, { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack direction="row" spacing={1}>
      <Button
        size="small"
        variant="contained"
        color="success"
        startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <CheckCircleIcon />}
        disabled={busy}
        onClick={handleApprove}
        sx={{ textTransform: "none", fontWeight: 600 }}
      >
        {translate("padmakara.approvals.approve")}
      </Button>
      <Button
        size="small"
        variant="outlined"
        color="error"
        startIcon={<CancelIcon />}
        disabled={busy}
        onClick={() => setRejectOpen(true)}
        sx={{ textTransform: "none", fontWeight: 600 }}
      >
        {translate("padmakara.approvals.reject")}
      </Button>

      {/* Reject dialog with optional message */}
      <Dialog open={rejectOpen} onClose={() => setRejectOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{translate("padmakara.approvals.rejectTitle")}</DialogTitle>
        <DialogContent>
          <MuiTextField
            autoFocus
            margin="dense"
            label={translate("padmakara.approvals.adminMessage")}
            placeholder={translate("padmakara.approvals.adminMessagePlaceholder")}
            fullWidth
            multiline
            minRows={2}
            value={adminMessage}
            onChange={(e) => setAdminMessage(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejectOpen(false)} disabled={busy}>
            {translate("ra.action.cancel")}
          </Button>
          <Button
            onClick={handleReject}
            color="error"
            variant="contained"
            disabled={busy}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            {translate("padmakara.approvals.reject")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
};

// ─── List ─────────────────────────────────────────────────────────────────────

export const ApprovalList = () => {
  const translate = useTranslate();
  return (
    <List
      sort={{ field: "requestedAt", order: "DESC" }}
      perPage={25}
    >
      <Datagrid bulkActionButtons={false}>
        <EmailField source="email" label={translate("padmakara.fields.email")} />
        <TextField source="firstName" label={translate("padmakara.fields.firstName")} />
        <TextField source="lastName" label={translate("padmakara.fields.lastName")} />
        <FunctionField
          label={translate("padmakara.approvals.message")}
          render={(record: any) =>
            record.message
              ? record.message.length > 60
                ? record.message.slice(0, 60) + "…"
                : record.message
              : "—"
          }
        />
        <TextField source="deviceName" label={translate("padmakara.approvals.device")} />
        <StatusChip />
        <DateField source="requestedAt" label={translate("padmakara.approvals.requestedAt")} showTime />
        <FunctionField
          label={translate("padmakara.approvals.reviewedBy")}
          render={(record: any) =>
            record.reviewedBy
              ? `${record.reviewedBy.firstName || ""} ${record.reviewedBy.lastName || ""}`.trim() || record.reviewedBy.email
              : "—"
          }
        />
        <ApprovalActions />
      </Datagrid>
    </List>
  );
};
