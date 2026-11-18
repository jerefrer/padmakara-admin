import type { Theme } from "@mui/material/styles";
import type { SystemStyleObject } from "@mui/system";

/**
 * Shared look of the statistics tables. Backgrounds are set on the cells, not
 * the row, and are opaque, so a sticky cell hides what scrolls under it.
 */

/** Solid hover tint: a touch of the brand colour mixed into the paper. */
export const hoverBackground = (theme: Theme): string =>
  `color-mix(in srgb, ${theme.palette.primary.main} 6%, ${theme.palette.background.paper})`;

/** Alternate row backgrounds, a solid hover, and a pointer when the rows open something. */
export const zebraRowSx =
  (clickable: boolean) =>
  (theme: Theme): SystemStyleObject<Theme> => ({
    "& > td": { bgcolor: "background.paper" },
    "&:nth-of-type(even) > td": { bgcolor: "grey.50" },
    ...(clickable && {
      cursor: "pointer",
      "&:hover > td, &:focus-visible > td": { bgcolor: hoverBackground(theme) },
      "&:focus-visible": { outline: `2px solid ${theme.palette.primary.light}`, outlineOffset: -2 },
    }),
  });

/** A numeric cell: right-aligned, one line. */
export const numberCellSx: SystemStyleObject<Theme> = {
  textAlign: "right",
  whiteSpace: "nowrap",
  px: 1.25,
  py: 1,
};

/** Header cells sit on the page ground colour, opaque for the sticky header. */
export const headCellSx: SystemStyleObject<Theme> = {
  bgcolor: "background.default",
};

/** The totals row: same ground as the header, a heavier top rule, bold figures. */
export const totalCellSx = (theme: Theme): SystemStyleObject<Theme> => ({
  bgcolor: "background.default",
  fontWeight: 600,
  borderTop: `2px solid ${theme.palette.divider}`,
  borderBottom: 0,
});
