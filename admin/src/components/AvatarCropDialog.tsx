import { useRef, useState } from "react";
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
} from "@mui/material";

interface AvatarCropDialogProps {
  open: boolean;
  image: File | null;
  onClose: () => void;
  onSave: (blob: Blob) => void;
  saving?: boolean;
}

export function AvatarCropDialog({
  open,
  image,
  onClose,
  onSave,
  saving = false,
}: AvatarCropDialogProps) {
  const editorRef = useRef<AvatarEditorRef | null>(null);
  const [zoom, setZoom] = useState(1.2);

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
          {image && (
            <AvatarEditor
              ref={editorRef}
              image={image}
              width={300}
              height={300}
              borderRadius={150}
              border={30}
              scale={zoom}
              rotate={0}
            />
          )}
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
