import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";

type MediaSource =
  | { kind: "track"; trackId: number; mediaType: "audio" | "video" }
  | { kind: "session-video"; sessionId: number };

interface MediaPreviewDialogProps {
  open: boolean;
  title: string;
  source: MediaSource | null;
  onClose: () => void;
}

interface ResolvedMedia {
  url: string;
  mediaType: "audio" | "video" | "iframe";
}

async function fetchMedia(source: MediaSource): Promise<ResolvedMedia> {
  const token = localStorage.getItem("accessToken");
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};

  if (source.kind === "track") {
    const res = await fetch(`/api/media/audio/${source.trackId}`, { headers });
    if (!res.ok) throw new Error(`Failed to load media (${res.status})`);
    const json = (await res.json()) as { url: string };
    return { url: json.url, mediaType: source.mediaType };
  }

  // Session video — Bunny iframe is the simplest reliable player here.
  const res = await fetch(`/api/media/video/session/${source.sessionId}`, { headers });
  if (!res.ok) throw new Error(`Failed to load video (${res.status})`);
  const json = (await res.json()) as { iframe: string };
  return { url: json.iframe, mediaType: "iframe" };
}

export const MediaPreviewDialog = ({
  open,
  title,
  source,
  onClose,
}: MediaPreviewDialogProps) => {
  const [media, setMedia] = useState<ResolvedMedia | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !source) {
      setMedia(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMedia(source)
      .then((m) => {
        if (!cancelled) setMedia(m);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unknown error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, source]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>
        {title}
        <IconButton
          onClick={onClose}
          sx={{ position: "absolute", right: 8, top: 8, color: "text.secondary" }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        {loading && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress />
          </Box>
        )}
        {error && (
          <Typography color="error" sx={{ py: 2 }}>
            {error}
          </Typography>
        )}
        {!loading && !error && media && media.mediaType === "audio" && (
          <Box sx={{ py: 2 }}>
            <audio
              src={media.url}
              controls
              autoPlay
              style={{ width: "100%" }}
            />
          </Box>
        )}
        {!loading && !error && media && media.mediaType === "video" && (
          <Box sx={{ py: 1 }}>
            <video
              src={media.url}
              controls
              autoPlay
              style={{ width: "100%", maxHeight: "70vh", display: "block" }}
            />
          </Box>
        )}
        {!loading && !error && media && media.mediaType === "iframe" && (
          <Box sx={{ position: "relative", pt: "56.25%" }}>
            <iframe
              src={media.url}
              title={title}
              allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                border: 0,
              }}
            />
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
};
