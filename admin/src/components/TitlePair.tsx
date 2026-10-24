/**
 * Collapsed-row title display shared by the track table and the event video
 * list: the English title on the first line, the Portuguese one underneath as
 * a smaller grey line. A title that an AI wrote and nobody has confirmed gets
 * the AI-review chip next to its line; clicking the chip marks it reviewed
 * without opening the row's editor.
 */

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { TypographyProps } from "@mui/material/Typography";
import { useTranslate } from "react-admin";
import { AiReviewChip } from "./TranslatableField";

export type TitleLang = "en" | "pt";

interface TitlePairProps {
  titleEn: string | null | undefined;
  titlePt: string | null | undefined;
  /** Shown as the first line when both titles are empty. */
  fallback: string;
  /** Missing flags count as reviewed (rows that predate the flags). */
  titleEnReviewed?: boolean;
  titlePtReviewed?: boolean;
  onMarkReviewed: (lang: TitleLang) => void;
  /** Props for the first-line Typography (weight, click-to-edit handlers). */
  primaryProps?: TypographyProps;
}

export const TitlePair = ({
  titleEn,
  titlePt,
  fallback,
  titleEnReviewed = true,
  titlePtReviewed = true,
  onMarkReviewed,
  primaryProps,
}: TitlePairProps) => {
  const translate = useTranslate();
  const en = titleEn?.trim() || "";
  const pt = titlePt?.trim() || "";
  // With no English title (or the same text in both) the Portuguese one is
  // already the first line, so it is not repeated underneath.
  const ptIsPrimary = !!pt && (!en || en === pt);
  const primaryText = en || pt || fallback;
  const primaryChipLang: TitleLang | null =
    en && !titleEnReviewed ? "en" : ptIsPrimary && !titlePtReviewed ? "pt" : null;

  const markReviewed = (lang: TitleLang) => (e: React.MouseEvent) => {
    // The chip sits inside a click-to-edit row.
    e.stopPropagation();
    onMarkReviewed(lang);
  };

  return (
    <>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
        <Typography variant="body2" noWrap {...primaryProps} sx={{ minWidth: 0, ...primaryProps?.sx }}>
          {primaryText}
        </Typography>
        {primaryChipLang && (
          <Box sx={{ display: "flex", flexShrink: 0 }} onClick={markReviewed(primaryChipLang)}>
            <AiReviewChip onClick={() => undefined} />
          </Box>
        )}
      </Box>
      {!ptIsPrimary && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
          <Typography
            variant="caption"
            noWrap
            data-testid="pt-title-line"
            sx={{
              minWidth: 0,
              color: pt ? "text.secondary" : "text.disabled",
              fontStyle: pt ? "normal" : "italic",
              fontSize: "0.72rem",
              lineHeight: 1.3,
            }}
          >
            {pt || translate("padmakara.events.noPtTitle")}
          </Typography>
          {pt && !titlePtReviewed && (
            <Box sx={{ display: "flex", flexShrink: 0 }} onClick={markReviewed("pt")}>
              <AiReviewChip onClick={() => undefined} />
            </Box>
          )}
        </Box>
      )}
    </>
  );
};
