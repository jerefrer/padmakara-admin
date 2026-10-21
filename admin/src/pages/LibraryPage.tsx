import { useCallback, useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import LinearProgress from "@mui/material/LinearProgress";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { Title, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";

interface Status { count: number; uploadedAt: string | null }
interface UploadResult {
  imported: number;
  previous: number;
  withDates: number;
  linkedEventsWithoutRecord: number;
}

/**
 * Upload (and replace) the association's library CSV — the Wix "libraryEvent"
 * export the event form's "Library metadata" button reads from.
 */
export const LibraryPage = () => {
  const translate = useTranslate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const res = await authFetch("/api/admin/library/status");
    if (res.ok) setStatus((await res.json()) as Status);
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const upload = async (file: File) => {
    if (status?.count && !window.confirm(translate("padmakara.library.replaceConfirm", { count: status.count }))) {
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await authFetch("/api/admin/library/upload", { method: "POST", body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message ?? json?.error ?? `HTTP ${res.status}`);
      setResult(json as UploadResult);
      await loadStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <Box sx={{ maxWidth: 720, mx: "auto", pt: 3 }}>
      <Title title={translate("padmakara.library.pageTitle")} />
      <Paper sx={{ p: 3 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>{translate("padmakara.library.pageTitle")}</Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
          {translate("padmakara.library.pageIntro")}
        </Typography>

        <Typography variant="body2" sx={{ mb: 2 }}>
          {status === null
            ? ""
            : status.count === 0
              ? translate("padmakara.library.noneLoaded")
              : translate("padmakara.library.status", {
                  count: status.count,
                  date: status.uploadedAt ? new Date(status.uploadedAt).toLocaleString() : "—",
                })}
        </Typography>

        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <Button
          variant="contained"
          disableElevation
          disabled={busy}
          startIcon={<UploadFileIcon />}
          onClick={() => inputRef.current?.click()}
        >
          {status?.count ? translate("padmakara.library.replace") : translate("padmakara.library.upload")}
        </Button>

        {busy && <LinearProgress sx={{ mt: 2 }} />}
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
        {result && (
          <Alert severity="success" sx={{ mt: 2 }}>
            {translate("padmakara.library.uploaded", { imported: result.imported, previous: result.previous })}
            {result.linkedEventsWithoutRecord > 0 && (
              <Box sx={{ mt: 0.5 }}>
                {translate("padmakara.library.orphans", { count: result.linkedEventsWithoutRecord })}
              </Box>
            )}
          </Alert>
        )}
      </Paper>
    </Box>
  );
};
