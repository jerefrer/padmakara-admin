import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";
import { useTranslate } from "react-admin";
import Hls from "hls.js";
import { authFetch } from "../utils/authFetch";
import {
  buildSubtitleOptions,
  SUBTITLES_OFF,
  type SubtitleOption,
  type SubtitleTrackDescriptor,
} from "./subtitleTracks";

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

// Plays an HLS URL via hls.js (Chrome/Firefox) or native HLS (Safari), with a
// subtitle selector. Subtitles are soft WebVTT tracks that the backend injects
// into the HLS manifest off-by-default — reading them from the playing manifest
// means the preview matches exactly what the app renders (including the
// server-side cue timing offset), which fetching the raw .vtt would not.
function HlsVideo({ src }: { src: string }) {
  const translate = useTranslate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [options, setOptions] = useState<SubtitleOption[]>([]);
  const [selected, setSelected] = useState<number>(SUBTITLES_OFF);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setOptions([]);
    setSelected(SUBTITLES_OFF);
    const offLabel = translate("padmakara.subtitles.previewOff") || "Off";

    // Safari plays HLS natively and owns the text tracks itself.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      let forcedOff = false;
      const refresh = () => {
        const tracks = Array.from(video.textTracks);
        if (!forcedOff && tracks.length > 0) {
          // Match the app: every track starts off until the reviewer opts in.
          tracks.forEach((tt) => {
            tt.mode = "disabled";
          });
          forcedOff = true;
        }
        const descriptors: SubtitleTrackDescriptor[] = tracks.map((tt, i) => ({
          id: i,
          lang: tt.language,
          label: tt.label,
          kind: tt.kind,
        }));
        setOptions(buildSubtitleOptions(descriptors, offLabel));
      };
      video.textTracks.addEventListener?.("addtrack", refresh);
      video.textTracks.addEventListener?.("removetrack", refresh);
      video.addEventListener("loadedmetadata", refresh);
      refresh();
      return () => {
        video.textTracks.removeEventListener?.("addtrack", refresh);
        video.textTracks.removeEventListener?.("removetrack", refresh);
        video.removeEventListener("loadedmetadata", refresh);
      };
    }

    // hls.js path (Chrome/Firefox/etc).
    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      let forcedOff = false;
      const refresh = () => {
        if (!forcedOff && hls.subtitleTracks.length > 0) {
          hls.subtitleTrack = SUBTITLES_OFF; // AUTOSELECT=NO,DEFAULT=NO — stay off.
          forcedOff = true;
        }
        const descriptors: SubtitleTrackDescriptor[] = hls.subtitleTracks.map(
          (t) => ({ id: t.id, lang: t.lang, label: t.name }),
        );
        setOptions(buildSubtitleOptions(descriptors, offLabel));
      };
      hls.on(Hls.Events.MANIFEST_PARSED, refresh);
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, refresh);
      hls.loadSource(src);
      hls.attachMedia(video);
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }

    video.src = src;
  }, [src, translate]);

  const selectSubtitle = (value: number) => {
    setSelected(value);
    const hls = hlsRef.current;
    if (hls) {
      hls.subtitleTrack = value; // -1 disables.
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    Array.from(video.textTracks).forEach((tt, i) => {
      tt.mode = i === value ? "showing" : "disabled";
    });
  };

  return (
    <Box>
      {options.length > 1 && (
        <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 1 }}>
          <TextField
            select
            size="small"
            label={translate("padmakara.subtitles.previewLabel") || "Subtitles"}
            value={selected}
            onChange={(e) => selectSubtitle(Number(e.target.value))}
            sx={{ minWidth: 160 }}
          >
            {options.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        </Box>
      )}
      <video
        ref={videoRef}
        controls
        autoPlay
        style={{ width: "100%", maxHeight: "70vh", display: "block" }}
      />
    </Box>
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
