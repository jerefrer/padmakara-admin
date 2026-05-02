import { useState, useEffect, useCallback, useRef } from "react";
import Cropper, { type Area, type Point } from "react-easy-crop";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Slider,
  Box,
  Typography,
} from "@mui/material";

export type CropMode = "avatar" | "hero";

export interface HeroSaveParams {
  /** Cropped/zoomed hero region in image pixels (used to produce the stored image). */
  cropAreaPixels: Area;
  /** Focal point (subject location) within the CROPPED image, 0..100 each. */
  focalX: number;
  focalY: number;
}

interface BaseProps {
  open: boolean;
  image: File | null;
  onClose: () => void;
  saving?: boolean;
  /**
   * For "hero" re-edit mode: the focal point already saved (in % of the
   * stored hero), to seed the marker. Defaults to {50, 50}.
   */
  initialFocal?: { x: number; y: number };
}

type Props =
  | (BaseProps & { mode: "avatar"; onSave: (blob: Blob) => void })
  | (BaseProps & { mode: "hero"; onSave: (params: HeroSaveParams) => void | Promise<void> });

const AVATAR_ASPECT = 1;
const HERO_ASPECT = 16 / 9;
const VIEWPORT_W = 560;
const AVATAR_VIEWPORT_H = 560;
const HERO_VIEWPORT_H = 315;

export function ImageCropDialog(props: Props) {
  const { open, image, onClose, saving = false, initialFocal, mode } = props;

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);

  // Focal marker position, in % of the visible CROPPED area (the rectangle
  // that will be saved). Only meaningful in hero mode.
  const [focal, setFocal] = useState<{ x: number; y: number }>({ x: 50, y: 50 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const draggingFocalRef = useRef(false);

  // Convert the File to an object URL for the cropper.
  useEffect(() => {
    if (!image) {
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  // Reset on open/close.
  useEffect(() => {
    if (!open) {
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setCroppedAreaPixels(null);
      setFocal({ x: 50, y: 50 });
    } else if (initialFocal) {
      setFocal({
        x: clamp(initialFocal.x, 0, 100),
        y: clamp(initialFocal.y, 0, 100),
      });
    }
  }, [open, initialFocal]);

  const onCropComplete = useCallback((_areaPercent: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  // Compute focal % from a pointer event over the viewport.
  const focalFromPointer = useCallback((clientX: number, clientY: number) => {
    const el = viewportRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: clamp(((clientX - rect.left) / rect.width) * 100, 0, 100),
      y: clamp(((clientY - rect.top) / rect.height) * 100, 0, 100),
    };
  }, []);

  // Marker drag (capture all moves until pointer up).
  const onMarkerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    draggingFocalRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onMarkerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingFocalRef.current) return;
    e.stopPropagation();
    const next = focalFromPointer(e.clientX, e.clientY);
    if (next) setFocal(next);
  };

  const onMarkerPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingFocalRef.current) return;
    draggingFocalRef.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  const handleSave = async () => {
    if (!image || !croppedAreaPixels) return;

    if (mode === "avatar") {
      const blob = await getCroppedBlob(image, croppedAreaPixels);
      props.onSave(blob);
    } else {
      await props.onSave({
        cropAreaPixels: croppedAreaPixels,
        focalX: Math.round(focal.x),
        focalY: Math.round(focal.y),
      });
    }
  };

  const aspect = mode === "avatar" ? AVATAR_ASPECT : HERO_ASPECT;
  const viewportW = VIEWPORT_W;
  const viewportH = mode === "avatar" ? AVATAR_VIEWPORT_H : HERO_VIEWPORT_H;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{mode === "avatar" ? "Crop Avatar" : "Adjust Hero Image"}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, pt: 1 }}>
          {imageUrl ? (
            <Box
              ref={viewportRef}
              sx={{
                position: "relative",
                width: viewportW,
                height: viewportH,
                bgcolor: "#222",
                borderRadius: 1,
                overflow: "hidden",
              }}
            >
              <Cropper
                image={imageUrl}
                crop={crop}
                zoom={zoom}
                aspect={aspect}
                cropShape={mode === "avatar" ? "round" : "rect"}
                showGrid={false}
                minZoom={1}
                maxZoom={4}
                objectFit="cover"
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
              {mode === "hero" && (
                <Box
                  onPointerDown={onMarkerPointerDown}
                  onPointerMove={onMarkerPointerMove}
                  onPointerUp={onMarkerPointerUp}
                  onPointerCancel={onMarkerPointerUp}
                  sx={{
                    position: "absolute",
                    left: `${focal.x}%`,
                    top: `${focal.y}%`,
                    width: 32,
                    height: 32,
                    transform: "translate(-50%, -50%)",
                    borderRadius: "50%",
                    bgcolor: "rgba(99, 102, 241, 0.9)",
                    border: "3px solid white",
                    boxShadow: "0 0 0 2px rgba(0,0,0,0.5), 0 2px 12px rgba(0,0,0,0.6)",
                    cursor: "grab",
                    touchAction: "none",
                    zIndex: 10,
                    "&:active": { cursor: "grabbing" },
                    "&::after": {
                      content: '""',
                      position: "absolute",
                      inset: 8,
                      borderRadius: "50%",
                      bgcolor: "white",
                    },
                  }}
                />
              )}
            </Box>
          ) : null}

          <Box sx={{ width: "100%", px: 2 }}>
            <Typography variant="body2" gutterBottom>
              Zoom
            </Typography>
            <Slider
              value={zoom}
              onChange={(_, v) => setZoom(v as number)}
              min={1}
              max={4}
              step={0.05}
              valueLabelDisplay="auto"
            />
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ textAlign: "center" }}>
            {mode === "avatar"
              ? "Drag to position, slide or scroll to zoom."
              : "Drag the image with the slider/scroll to zoom and frame. Click on the image to place the focal point (the spot that stays centered when the banner adapts to different screens)."}
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} variant="contained" disabled={saving || !croppedAreaPixels}>
          {saving ? "Saving..." : mode === "avatar" ? "Save Avatar" : "Save Hero"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

async function getCroppedBlob(file: File, areaPixels: Area): Promise<Blob> {
  const img = await loadImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = areaPixels.width;
  canvas.height = areaPixels.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2d context unavailable");
  ctx.drawImage(
    img,
    areaPixels.x,
    areaPixels.y,
    areaPixels.width,
    areaPixels.height,
    0,
    0,
    areaPixels.width,
    areaPixels.height,
  );
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Failed to encode blob"));
      },
      "image/jpeg",
      0.9,
    );
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export { getCroppedBlob };
