import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";
import { useTranslate } from "react-admin";
import Hls from "hls.js";
import { authFetch } from "../utils/authFetch";
import { chooseVideoEngine } from "./hlsEngine";

export type MediaSource =
  | { kind: "track"; trackId: number; mediaType: "audio" | "video" }
  | { kind: "video"; videoId: number };

interface MediaPreviewDialogProps {
  open: boolean;
  title: string;
  source: MediaSource | null;
  onClose: () => void;
}

interface ResolvedMedia {
  url: string;
  mediaType: "audio" | "video" | "iframe" | "hls" | "unavailable";
}

// Plays an HLS URL via hls.js (Chromium/Firefox) or native HLS (Safari/iOS).
// Subtitles are soft WebVTT tracks the backend injects into the manifest
// off-by-default; the browser's own <video controls> caption menu lists and
// toggles them (hls.js renders them as native TextTracks), so there is no
// separate subtitle UI here.
function HlsVideo({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Prefer hls.js wherever MSE works; use native HLS only when it can't run.
    // Checking native first is a trap: some Chromium builds report
    // canPlayType('…mpegurl')="maybe" but then fail a raw .m3u8 on video.src
    // with MediaError code 4. See chooseVideoEngine.
    const engine = chooseVideoEngine({
      hlsjsSupported: Hls.isSupported(),
      nativeHls: Boolean(video.canPlayType("application/vnd.apple.mpegurl")),
    });

    if (engine === "hlsjs") {
      const hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => hls.destroy();
    }

    // Native HLS (Safari/iOS), or last-resort direct assignment.
    video.src = src;
  }, [src]);

  return (
    <video
      ref={videoRef}
      controls
      autoPlay
      style={{ width: "100%", maxHeight: "70vh", display: "block" }}
    />
  );
}

async function fetchMedia(source: MediaSource): Promise<ResolvedMedia> {
  if (source.kind === "track") {
    const res = await authFetch(`/api/media/audio/${source.trackId}`);
    // 404 = the track has no audio object yet (keyless row). Surface it as a
    // calm "unavailable" state rather than a red error.
    if (res.status === 404) return { url: "", mediaType: "unavailable" };
    if (!res.ok) throw new Error(`Failed to load media (${res.status})`);
    const json = (await res.json()) as { url: string };
    return { url: json.url, mediaType: source.mediaType };
  }

  // Event video — play the backend HLS proxy (each Bunny sub-request is
  // signed server-side). The Bunny embed/iframe player 403s on this pull zone:
  // its CDN tokens are exact-URL only and don't cover the embed player's
  // internal playlist/segment/caption requests.
  const res = await authFetch(`/api/media/video/${source.videoId}`);
  if (!res.ok) throw new Error(`Failed to load video (${res.status})`);
  const json = (await res.json()) as { proxyHls: string };
  return { url: json.proxyHls, mediaType: "hls" };
}

export const MediaPreviewDialog = ({
  open,
  title,
  source,
  onClose,
}: MediaPreviewDialogProps) => {
  const translate = useTranslate();
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
        {!loading && !error && media && media.mediaType === "unavailable" && (
          <Typography color="text.secondary" sx={{ py: 3, textAlign: "center" }}>
            {translate("padmakara.tracks.noAudioBody") || "This track has no audio file yet."}
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
        {!loading && !error && media && media.mediaType === "hls" && (
          <Box sx={{ py: 1 }}>
            <HlsVideo src={media.url} />
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
