/**
 * A card whose header (chevron, title, one-line summary, optional amber badge)
 * stays visible while the body folds away. The header is a real button with
 * `aria-expanded`. The body stays mounted when closed, so uploads, polling and
 * unsaved form state in the sections survive a fold.
 *
 * An optional `action` (a tick box, say) sits at the right of the header, beside
 * the clickable area rather than inside it: no button inside a button, and using
 * the action never folds or unfolds the section.
 *
 * `useCollapsibleSections` keeps the open/closed state of a set of sections.
 * It is not remembered: a page always opens with the defaults, so editors
 * find every event laid out the same way.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Card from "@mui/material/Card";
import Collapse from "@mui/material/Collapse";
import Typography from "@mui/material/Typography";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";

interface CollapsibleSectionProps {
  /** Stable id, used for the DOM ids that tie the header to its body. */
  id: string;
  title: string;
  /** One muted line shown whether the section is open or closed. */
  summary?: ReactNode;
  /** Small amber flag for something missing; omitted when there is nothing to flag. */
  badge?: string | null;
  /** Control shown at the right of the header, still visible when the section is closed. */
  action?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export const CollapsibleSection = ({ id, title, summary, badge, action, open, onToggle, children }: CollapsibleSectionProps) => (
  <Card sx={{ mb: 2 }} data-section={id}>
    <Box sx={{ display: "flex", alignItems: "center" }}>
    <ButtonBase
      component="button"
      type="button"
      id={`${id}-header`}
      aria-expanded={open}
      aria-controls={`${id}-body`}
      onClick={onToggle}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        flex: 1,
        minWidth: 0,
        textAlign: "left",
        px: 2.5,
        py: 1.75,
        "&:hover": { backgroundColor: "rgba(0,0,0,0.02)" },
      }}
    >
      <ChevronRightIcon
        sx={{
          color: "text.secondary",
          transition: "transform 150ms ease",
          transform: open ? "rotate(90deg)" : "none",
        }}
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="h6" component="span" sx={{ display: "block", lineHeight: 1.3 }}>
          {title}
        </Typography>
        {summary ? (
          <Typography
            variant="body2"
            component="span"
            sx={{ display: "block", color: "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {summary}
          </Typography>
        ) : null}
      </Box>
      {badge ? (
        <Box
          component="span"
          sx={{
            flexShrink: 0,
            px: 1,
            py: 0.25,
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
            color: "#8A5A00",
            backgroundColor: "#FFF3D6",
            border: "1px solid #F2D9A0",
          }}
        >
          {badge}
        </Box>
      ) : null}
    </ButtonBase>
    {action ? (
      <Box data-section-action={id} sx={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 1, pr: 2 }}>
        {action}
      </Box>
    ) : null}
    </Box>
    <Collapse in={open} timeout="auto">
      <Box
        id={`${id}-body`}
        role="region"
        aria-labelledby={`${id}-header`}
        sx={{
          px: 2.5,
          pb: 2.5,
          pt: 0.5,
          // Panels written as standalone cards sit flat inside the section card.
          // A bordered (outlined) panel, like the AI assistant, keeps its padding.
          "& > .MuiPaper-root:not(.MuiPaper-outlined)": { boxShadow: "none", px: 0, pt: 1 },
        }}
      >
        {children}
      </Box>
    </Collapse>
  </Card>
);

type OpenState = Record<string, boolean>;

/** Open/closed state of a fixed list of sections, starting from `defaults` on every mount. */
export function useCollapsibleSections(ids: readonly string[], defaults: OpenState) {
  const idsKey = ids.join("|");
  const [open, setOpen] = useState<OpenState>(() =>
    Object.fromEntries(ids.map((id) => [id, defaults[id] ?? false])),
  );

  const update = useCallback((fn: (prev: OpenState) => OpenState) => setOpen(fn), []);

  const toggle = useCallback((id: string) => update((prev) => ({ ...prev, [id]: !prev[id] })), [update]);
  const setAll = useCallback(
    (value: boolean) =>
      update(() => Object.fromEntries(idsKey.split("|").map((id) => [id, value])) as OpenState),
    [update, idsKey],
  );
  const allOpen = useMemo(() => idsKey.split("|").every((id) => open[id]), [idsKey, open]);

  return { open, toggle, setAll, allOpen };
}
