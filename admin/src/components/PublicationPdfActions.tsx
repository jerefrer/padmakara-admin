import { Box, Button } from "@mui/material";
import { useNotify, useTranslate } from "react-admin";
import { useState } from "react";
import { authFetch } from "../utils/authFetch";

type Disposition = "inline" | "attachment";

/**
 * Preview and download buttons for a publication's original PDF. Each click
 * asks the API for a short-lived presigned URL, so nothing is signed until
 * the admin actually needs the file.
 */
export function PublicationPdfActions({ publicationId }: { publicationId: number | string }) {
  const translate = useTranslate();
  const notify = useNotify();
  const [busy, setBusy] = useState<Disposition | null>(null);

  const open = async (disposition: Disposition) => {
    setBusy(disposition);
    // Open the tab synchronously, inside the click, so popup blockers allow it.
    const tab = disposition === "inline" ? window.open("about:blank", "_blank") : null;
    try {
      const res = await authFetch(`/api/admin/publications/${publicationId}/pdf-url?disposition=${disposition}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { url } = (await res.json()) as { url: string };
      if (tab) tab.location.href = url;
      else window.location.assign(url);
    } catch {
      tab?.close();
      notify(translate("padmakara.publications.pdfLinkFailed"), { type: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box sx={{ display: "flex", gap: 0.5, mt: 1, justifyContent: "center" }}>
      <Button size="small" variant="contained" disabled={busy !== null} onClick={() => open("inline")}>
        {translate("padmakara.publications.pdfPreview")}
      </Button>
      <Button size="small" variant="contained" disabled={busy !== null} onClick={() => open("attachment")}>
        {translate("padmakara.publications.pdfDownload")}
      </Button>
    </Box>
  );
}
