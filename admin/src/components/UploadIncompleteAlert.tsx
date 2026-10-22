import { useTranslate } from "react-admin";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import type { MissingAudioTrack } from "../utils/audioResume";

/** Show at most this many tracks; the rest are summarised as "…and N more". */
const MAX_LISTED = 12;

/**
 * Post-upload reconciliation warning: the bulk upload ended (normally, on an
 * error, or cancelled) and the server still has tracks without audio. Lists
 * them and points to the resume path.
 */
export const UploadIncompleteAlert = ({
  tracks,
  onResume,
}: {
  tracks: MissingAudioTrack[];
  onResume: () => void;
}) => {
  const translate = useTranslate();
  const listed = tracks.slice(0, MAX_LISTED);
  const hidden = tracks.length - listed.length;

  return (
    <Alert
      severity="warning"
      sx={{ mt: 2 }}
      action={
        <Button color="inherit" size="small" variant="outlined" onClick={onResume}>
          {translate("padmakara.events.resumeUpload")}
        </Button>
      }
    >
      <AlertTitle>
        {translate("padmakara.events.uploadIncompleteTitle", { smart_count: tracks.length })}
      </AlertTitle>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {translate("padmakara.events.uploadIncompleteBody")}
      </Typography>
      <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
        {listed.map((t) => (
          <Typography component="li" variant="caption" key={t.id} sx={{ display: "list-item" }}>
            {`S${t.sessionNumber} · ${t.trackNumber}. ${t.title}`}
            {t.originalFilename && (
              <Box component="span" sx={{ color: "text.secondary", fontFamily: "monospace", ml: 1 }}>
                {t.originalFilename}
              </Box>
            )}
          </Typography>
        ))}
      </Box>
      {hidden > 0 && (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {translate("padmakara.events.uploadIncompleteMore", { smart_count: hidden })}
        </Typography>
      )}
    </Alert>
  );
};
