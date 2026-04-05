import { useRef, useState, useEffect } from "react";
import AvatarEditor, { type AvatarEditorRef } from "react-avatar-editor";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Slider,
  Box,
  Typography,
  CircularProgress,
} from "@mui/material";

interface AvatarCropDialogProps {
  open: boolean;
  image: File | null;
  onClose: () => void;
  onSave: (blob: Blob) => void;
  saving?: boolean;
  initialPosition?: { x: number; y: number };
  initialScale?: number;
  detecting?: boolean;
}

export function AvatarCropDialog({
  open,
  image,
  onClose,
  onSave,
  saving = false,
  initialPosition,
  initialScale,
  detecting = false,
}: AvatarCropDialogProps) {
  const editorRef = useRef<AvatarEditorRef | null>(null);
  const [zoom, setZoom] = useState(1.2);
  // Track a key to force AvatarEditor remount when initial position changes
  const [editorKey, setEditorKey] = useState(0);

  // Apply initial scale when it arrives from face detection
  useEffect(() => {
    if (initialScale != null) setZoom(initialScale);
  }, [initialScale]);

  // Force editor remount when initial position arrives, so it picks up the new position
  useEffect(() => {
    if (initialPosition) setEditorKey((k) => k + 1);
  }, [initialPosition]);

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      setZoom(1.2);
      setEditorKey(0);
    }
  }, [open]);

  const handleSave = () => {
    if (!editorRef.current) return;
    const canvas = editorRef.current.getImageScaledToCanvas();
    canvas.toBlob(
      (blob: Blob | null) => {
        if (blob) onSave(blob);
      },
      "image/jpeg",
      0.9,
    );
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Crop Avatar</DialogTitle>
      <DialogContent>
        <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, pt: 1 }}>
          {detecting ? (
            <Box sx={{ width: 360, height: 360, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <CircularProgress size={32} />
              <Typography variant="body2" sx={{ ml: 1 }}>Detecting face...</Typography>
            </Box>
          ) : image ? (
            <AvatarEditor
              key={editorKey}
              ref={editorRef}
              image={image}
              width={300}
              height={300}
              borderRadius={150}
              border={30}
              scale={zoom}
              position={initialPosition}
              rotate={0}
            />
          ) : null}
          <Box sx={{ width: "100%", px: 2 }}>
            <Typography variant="body2" gutterBottom>
              Zoom
            </Typography>
            <Slider
              value={zoom}
              onChange={(_, v) => setZoom(v as number)}
              min={1}
              max={3}
              step={0.05}
              valueLabelDisplay="auto"
            />
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" disabled={saving}>
          {saving ? "Saving..." : "Save Avatar"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
