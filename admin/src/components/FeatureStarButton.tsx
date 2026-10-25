import { useState } from "react";
import { useDataProvider, useNotify, useRefresh, useTranslate } from "react-admin";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import { authFetch } from "../utils/authFetch";
import { apiErrorMessageKey } from "../utils/apiErrors";

interface FeatureStarButtonProps {
  eventId: number | string;
  status: string;
  /** True when this event currently holds the home-page highlight. */
  featured: boolean;
  /** Locale-aware title shown in the confirmation dialog. */
  title: string;
  /** Locale-aware title of an event record, used to name the current highlight. */
  titleOf?: (record: { titleEn?: string | null; titlePt?: string | null }) => string;
  size?: "small" | "medium";
  iconSize?: number;
  /** Called with the updated event once the highlight has moved here. */
  onFeatured?: (event: { featuredAt?: string | null }) => void;
}

/**
 * The highlight star. A filled star is read-only (the highlight can only be
 * moved by starring another event); an empty star on a published event opens a
 * confirmation dialog and calls POST /admin/events/:id/feature.
 */
export function FeatureStarButton({
  eventId,
  status,
  featured,
  title,
  titleOf = (r) => r.titleEn ?? "",
  size = "small",
  iconSize,
  onFeatured,
}: FeatureStarButtonProps) {
  const translate = useTranslate();
  const notify = useNotify();
  const refresh = useRefresh();
  const dataProvider = useDataProvider();
  const [open, setOpen] = useState(false);
  const [currentTitle, setCurrentTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const iconSx = iconSize ? { fontSize: iconSize } : undefined;

  if (featured) {
    return (
      <Tooltip title={translate("padmakara.events.featuredLocked")}>
        {/* span: a disabled button does not fire the pointer events a tooltip needs */}
        <span>
          <IconButton size={size} disabled sx={{ "&.Mui-disabled": { color: "#f59e0b" } }}>
            <StarIcon sx={iconSx} />
          </IconButton>
        </span>
      </Tooltip>
    );
  }

  if (status !== "published") {
    return (
      <Tooltip title={translate("padmakara.events.featuredOnlyPublished")}>
        <span>
          <IconButton size={size} disabled>
            <StarBorderIcon sx={iconSx} />
          </IconButton>
        </span>
      </Tooltip>
    );
  }

  const openDialog = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentTitle(null);
    setOpen(true);
    try {
      const { data } = await dataProvider.getList("events", {
        pagination: { page: 1, perPage: 1 },
        sort: { field: "featuredAt", order: "DESC" },
        filter: {},
      });
      const current = data[0];
      if (current && current.featuredAt && String(current.id) !== String(eventId)) {
        setCurrentTitle(titleOf(current));
      }
    } catch {
      // The dialog still works without naming the current highlight.
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const res = await authFetch(`/api/admin/events/${eventId}/feature`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { code?: string } | null;
        throw Object.assign(new Error(`HTTP ${res.status}`), { code: body?.code });
      }
      const updated = await res.json();
      notify("padmakara.events.featuredSetNotify", { type: "success" });
      setOpen(false);
      onFeatured?.(updated);
      refresh();
    } catch (error: any) {
      setOpen(false);
      notify(apiErrorMessageKey(error), { type: "error", messageArgs: { message: error.message } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Tooltip title={translate("padmakara.events.featuredSet")}>
        <IconButton size={size} onClick={openDialog} sx={{ color: "action.disabled" }}>
          <StarBorderIcon sx={iconSx} />
        </IconButton>
      </Tooltip>
      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        onClick={(e) => e.stopPropagation()}
      >
        <DialogTitle>{translate("padmakara.events.featuredDialogTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {currentTitle
              ? translate("padmakara.events.featuredDialogMove", { current: currentTitle, title })
              : translate("padmakara.events.featuredDialogSet", { title })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={busy}>
            {translate("padmakara.events.cancel")}
          </Button>
          <Button onClick={confirm} variant="contained" disabled={busy}>
            {translate("padmakara.events.featuredDialogConfirm")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
