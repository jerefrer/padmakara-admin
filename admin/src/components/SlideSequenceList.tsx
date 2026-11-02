/**
 * Left column of the slide editor: the sequence. INTRO with its slides, the
 * dashed Video block, then OUTRO with its slides. Each slide is a real button
 * with a small rendered thumbnail, its label and its length.
 */

import AddIcon from "@mui/icons-material/Add";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import UploadIcon from "@mui/icons-material/Upload";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useMemo } from "react";
import { useTranslate } from "react-admin";
import { renderSlideHtml } from "@slides/render.ts";
import { isClipSlide, slideTotalMs, type Slide, type SlideRole } from "@slides/types.ts";
import { slideEditorTokens } from "../slideEditorTokens";
import {
  formatClock,
  formatSecondsLabel,
  sequenceDurationMs,
  slideLabel,
  type VideoBlockState,
} from "../utils/slideSequence";
import type { SlideSequenceKey } from "../utils/slideDocument";
import { BurnActionButton, BurnStatusChip, type BurnDisk } from "./SlideEditor";

const THUMB_WIDTH = 64;
const THUMB_HEIGHT = 36;
const FONT_BASE_URL = "/fonts/";

interface SlideThumbProps {
  slide: Slide;
  resolveImageUrl: (s3Key: string) => string;
}

/** The slide rendered by the shared renderer at thumbnail size. */
const SlideThumb = ({ slide, resolveImageUrl }: SlideThumbProps) => {
  const html = useMemo(
    () =>
      isClipSlide(slide)
        ? null
        : renderSlideHtml(slide, {
            width: THUMB_WIDTH,
            height: THUMB_HEIGHT,
            fontBaseUrl: FONT_BASE_URL,
            resolveImageUrl,
          }),
    [slide, resolveImageUrl],
  );

  return (
    <Box
      aria-hidden
      sx={{
        width: THUMB_WIDTH,
        height: THUMB_HEIGHT,
        flexShrink: 0,
        backgroundColor: "#000",
        borderRadius: 0.5,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {html ? (
        <iframe
          title=""
          tabIndex={-1}
          srcDoc={html}
          style={{ width: THUMB_WIDTH, height: THUMB_HEIGHT, border: "none", pointerEvents: "none", display: "block" }}
        />
      ) : (
        <LockOutlinedIcon sx={{ fontSize: 16, color: "rgba(255,255,255,0.7)" }} />
      )}
    </Box>
  );
};

interface SequenceSectionProps {
  title: string;
  sequence: SlideSequenceKey;
  slides: Slide[];
  selectedId: string | null;
  resolveImageUrl: (s3Key: string) => string;
  onSelect: (sequence: SlideSequenceKey, slideId: string) => void;
  onAdd: (sequence: SlideSequenceKey) => void;
  roleName: (role: SlideRole) => string;
  showTotal: boolean;
}

const SequenceSection = ({
  title,
  sequence,
  slides,
  selectedId,
  resolveImageUrl,
  onSelect,
  onAdd,
  roleName,
  showTotal,
}: SequenceSectionProps) => {
  const translate = useTranslate();
  return (
    <Box component="section" aria-label={title}>
      <Box sx={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", px: 0.5, mb: 0.75 }}>
        <Box
          component="h3"
          sx={{ m: 0, fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.08em", color: slideEditorTokens.muted }}
        >
          {title}
        </Box>
        {showTotal && (
          <Box component="span" sx={{ fontSize: "0.72rem", color: slideEditorTokens.muted }}>
            {formatClock(sequenceDurationMs(slides))}
          </Box>
        )}
      </Box>
      <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.75 }}>
        {slides.map((slide) => {
          const selected = slide.id === selectedId;
          return (
            <li key={slide.id}>
              <Box
                component="button"
                type="button"
                onClick={() => onSelect(sequence, slide.id)}
                aria-current={selected ? "true" : undefined}
                sx={{
                  all: "unset",
                  boxSizing: "border-box",
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  p: 0.75,
                  borderRadius: 1.5,
                  cursor: "pointer",
                  backgroundColor: "background.paper",
                  border: "1px solid",
                  borderColor: selected ? "primary.main" : slideEditorTokens.border,
                  boxShadow: selected ? "0 0 0 1px #9B1B1B" : "none",
                  "&:hover": { borderColor: selected ? "primary.main" : slideEditorTokens.borderStrong },
                  "&:focus-visible": { outline: "2px solid #9B1B1B", outlineOffset: 2 },
                }}
              >
                <SlideThumb slide={slide} resolveImageUrl={resolveImageUrl} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Box
                    sx={{
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      color: slideEditorTokens.ink,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {isClipSlide(slide)
                      ? translate("padmakara.slides.logoClipTitle", { _: "Padmakara logo animation" })
                      : slideLabel(slide, roleName)}
                  </Box>
                  <Box sx={{ fontSize: "0.72rem", color: slideEditorTokens.muted }}>
                    {formatSecondsLabel(slideTotalMs(slide))}
                  </Box>
                </Box>
              </Box>
            </li>
          );
        })}
      </Box>
      <Button
        size="small"
        startIcon={<AddIcon sx={{ fontSize: 16 }} />}
        onClick={() => onAdd(sequence)}
        sx={{ mt: 0.75, color: "primary.main", fontSize: "0.78rem" }}
      >
        {translate("padmakara.slides.addSlideShort", { _: "Add slide" })}
      </Button>
    </Box>
  );
};

interface VideoBlockProps {
  state: VideoBlockState;
  burnStatus: string | null;
  burnError: string | null;
  burnDisk: BurnDisk | null;
  hasMaster: boolean;
  slideCount: number;
  reburning: boolean;
  onReburn: () => void | Promise<unknown>;
  onUploadVideo?: () => void;
}

const VideoBlock = ({
  state,
  burnStatus,
  burnError,
  burnDisk,
  hasMaster,
  slideCount,
  reburning,
  onReburn,
  onUploadVideo,
}: VideoBlockProps) => {
  const translate = useTranslate();
  return (
    <Box
      component="section"
      aria-label={translate("padmakara.slides.videoBlock.title", { _: "Video" })}
      sx={{
        border: `1px dashed ${slideEditorTokens.borderStrong}`,
        borderRadius: 1.5,
        px: 1.25,
        py: 1,
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
      }}
    >
      <Box sx={{ fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.08em", color: slideEditorTokens.muted }}>
        {translate("padmakara.slides.videoBlock.title", { _: "Video" }).toUpperCase()}
      </Box>
      {state === "notUploaded" && (
        <>
          <Box sx={{ fontSize: "0.8rem", color: slideEditorTokens.ink }}>
            {translate("padmakara.slides.videoBlock.notUploaded", { _: "Not uploaded yet" })}
          </Box>
          {onUploadVideo && (
            <Button
              size="small"
              startIcon={<UploadIcon sx={{ fontSize: 15 }} />}
              onClick={onUploadVideo}
              sx={{ alignSelf: "flex-start", color: "primary.main", fontSize: "0.78rem", px: 0.5 }}
            >
              {translate("padmakara.videos.uploadVideo", { _: "Upload video" })}
            </Button>
          )}
        </>
      )}
      {state === "uploaded" && (
        <Box sx={{ fontSize: "0.8rem", color: slideEditorTokens.ink }}>
          {translate("padmakara.slides.videoBlock.uploaded", { _: "Uploaded" })}
        </Box>
      )}
      {state === "burn" && <BurnStatusChip status={burnStatus} error={burnError} disk={burnDisk} />}
      <BurnActionButton
        hasMaster={hasMaster}
        slideCount={slideCount}
        burnStatus={burnStatus}
        reburning={reburning}
        onReburn={onReburn}
      />
    </Box>
  );
};

export interface SlideSequenceListProps {
  intro: Slide[];
  outro: Slide[];
  selection: { sequence: SlideSequenceKey; slideId: string | null };
  resolveImageUrl: (s3Key: string) => string;
  onSelect: (sequence: SlideSequenceKey, slideId: string) => void;
  onAdd: (sequence: SlideSequenceKey) => void;
  /** Offer to put the logo animation back at the start of the intro. */
  onAddLogo?: () => void;
  video: VideoBlockProps;
}

export const SlideSequenceList = ({
  intro,
  outro,
  selection,
  resolveImageUrl,
  onSelect,
  onAdd,
  onAddLogo,
  video,
}: SlideSequenceListProps) => {
  const translate = useTranslate();
  const roleName = (role: SlideRole): string =>
    translate(`padmakara.slides.role.${role}`, { _: role.charAt(0).toUpperCase() + role.slice(1) });

  return (
    <Box
      component="nav"
      aria-label={translate("padmakara.slides.sequence", { _: "Slide sequence" })}
      sx={{
        width: 236,
        flexShrink: 0,
        overflowY: "auto",
        backgroundColor: slideEditorTokens.rail,
        borderRight: `1px solid ${slideEditorTokens.border}`,
        p: 1.5,
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <SequenceSection
        title={translate("padmakara.slides.intro", { _: "Intro" }).toUpperCase()}
        sequence="intro"
        slides={intro}
        selectedId={selection.sequence === "intro" ? selection.slideId : null}
        resolveImageUrl={resolveImageUrl}
        onSelect={onSelect}
        onAdd={onAdd}
        roleName={roleName}
        showTotal
      />
      {onAddLogo && (
        <Button size="small" onClick={onAddLogo} sx={{ alignSelf: "flex-start", mt: -1.5, color: "primary.main", fontSize: "0.78rem" }}>
          {translate("padmakara.slides.addLogoClip", { _: "Add logo animation" })}
        </Button>
      )}
      <VideoBlock {...video} />
      <SequenceSection
        title={translate("padmakara.slides.outro", { _: "Outro" }).toUpperCase()}
        sequence="outro"
        slides={outro}
        selectedId={selection.sequence === "outro" ? selection.slideId : null}
        resolveImageUrl={resolveImageUrl}
        onSelect={onSelect}
        onAdd={onAdd}
        roleName={roleName}
        showTotal
      />
    </Box>
  );
};
