import { useRef, useState } from "react";
import { useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { MAX_NOTIFY_MESSAGE_LENGTH } from "./EventStatusControls";
import { announceBody, defaultTicked, type AnnounceKind, type AnnouncementsInfo, type Ticked } from "../utils/announce";

const KIND_LABEL_KEYS: Record<AnnounceKind, string> = {
  transcripts: "padmakara.events.announceKindTranscripts",
  videos: "padmakara.events.announceKindVideos",
  texts: "padmakara.events.announceKindTexts",
};

interface AnnounceContentButtonProps {
  /** The button only exists for a published event. */
  status: string;
  /** Asked each time the dialog opens, so the state is always current. */
  load: () => Promise<AnnouncementsInfo>;
  /** The confirmed request body for POST /events/:id/announce. */
  onConfirm: (body: ReturnType<typeof announceBody>) => void;
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString();

/** "Announce new content": a second email once transcripts, videos or texts are ready. */
export function AnnounceContentButton({ status, load, onConfirm }: AnnounceContentButtonProps) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<AnnouncementsInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [ticked, setTicked] = useState<Ticked>({});
  const [message, setMessage] = useState("");
  // Answers of an earlier dialog must not land in a later one
  const askCount = useRef(0);

  if (status !== "published") return null;

  const openDialog = () => {
    setInfo(null);
    setFailed(false);
    setTicked({});
    setMessage("");
    setOpen(true);
    const mine = ++askCount.current;
    load()
      .then((loaded) => {
        if (askCount.current !== mine) return;
        setInfo(loaded);
        setTicked(defaultTicked(loaded));
      })
      .catch(() => { if (askCount.current === mine) setFailed(true); });
  };

  const body = info ? announceBody(info, ticked, message) : null;
  const canSend = !!body && body.kinds.length > 0 && (info?.recipients ?? 0) > 0;

  return (
    <>
      <Button
        variant="outlined"
        size="small"
        sx={{ flexShrink: 0 }}
        onClick={openDialog}
        data-testid="announce-open"
      >
        {translate("padmakara.events.announceButton")}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>{translate("padmakara.events.announceTitle")}</DialogTitle>
        <DialogContent>
          <Typography>{translate("padmakara.events.announceMessage")}</Typography>
          {failed && (
            <Typography color="error" sx={{ mt: 1.5 }}>{translate("padmakara.events.announceLoadFailed")}</Typography>
          )}
          {info && (
            <>
              <Box sx={{ mt: 1.5, display: "flex", flexDirection: "column" }}>
                {info.kinds.map((k) => (
                  <Box key={k.kind}>
                    <FormControlLabel
                      disabled={!k.available}
                      control={
                        <Checkbox
                          size="small"
                          checked={!!ticked[k.kind]}
                          onChange={(e) => setTicked((prev) => ({ ...prev, [k.kind]: e.target.checked }))}
                          slotProps={{ input: { "data-testid": `announce-kind-${k.kind}` } as object }}
                        />
                      }
                      label={translate(KIND_LABEL_KEYS[k.kind])}
                    />
                    {!k.available && k.reason && (
                      <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mt: -0.5 }}>
                        {translate(k.reason === "hidden" ? "padmakara.events.announceReasonHidden" : "padmakara.events.announceReasonEmpty")}
                      </Typography>
                    )}
                    {k.announcedAt && (
                      <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mt: -0.5 }}>
                        {translate("padmakara.events.announceAlreadyAnnounced", { date: shortDate(k.announcedAt) })}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Box>
              {body?.force && (
                <Typography variant="body2" color="warning.main" sx={{ mt: 1 }} data-testid="announce-resend-warning">
                  {translate("padmakara.events.announceResendWarning")}
                </Typography>
              )}
              <Typography sx={{ mt: 1.5 }}>
                {translate("padmakara.events.announceRecipients", { smart_count: info.recipients })}
              </Typography>
              <TextField
                multiline
                minRows={3}
                fullWidth
                size="small"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                label={translate("padmakara.events.notifyMessageLabel")}
                helperText={translate("padmakara.events.notifyMessageHint")}
                slotProps={{ htmlInput: { maxLength: MAX_NOTIFY_MESSAGE_LENGTH, "data-testid": "announce-message" } }}
                sx={{ mt: 1.5 }}
              />
              {(info.published || info.history.length > 0) && (
                <Box sx={{ mt: 2 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    {translate("padmakara.events.announceHistory")}
                  </Typography>
                  {info.published && (
                    <Typography variant="body2" color="text.secondary">
                      {translate("padmakara.events.announceHistoryPublished", {
                        date: shortDate(info.published.at),
                        smart_count: info.published.count,
                      })}
                    </Typography>
                  )}
                  {info.history.map((h) => (
                    <Typography key={h.sentAt} variant="body2" color="text.secondary" data-testid="announce-history-item">
                      {translate("padmakara.events.announceHistoryItem", {
                        kinds: h.kinds.map((kind) => translate(KIND_LABEL_KEYS[kind])).join(", "),
                        date: shortDate(h.sentAt),
                        smart_count: h.count,
                      })}
                    </Typography>
                  ))}
                </Box>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setOpen(false)}>{translate("padmakara.events.cancel")}</Button>
          <Button
            variant="contained"
            disableElevation
            disabled={!canSend}
            onClick={() => {
              if (!canSend || !body) return;
              onConfirm(body);
              setOpen(false);
            }}
            data-testid="confirm-change-ok"
          >
            {translate("padmakara.events.announceConfirm")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
