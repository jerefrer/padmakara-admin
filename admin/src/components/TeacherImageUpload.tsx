import { useState, useCallback, useRef } from "react";
import { useRecordContext, useNotify, useRefresh } from "react-admin";
import { Box, Button, Typography, CircularProgress } from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import EditIcon from "@mui/icons-material/Edit";
import { ImageCropDialog, applyGrayscale, type HeroSaveParams } from "./ImageCropDialog";
import { authFetch } from "../utils/authFetch";

type DialogState =
  | { kind: "closed" }
  | { kind: "avatar"; file: File }
  | {
      kind: "hero";
      file: File;
      /** Initial focal % to seed the marker (existing hero re-edit). */
      initialFocal?: { x: number; y: number };
    };

async function uploadTeacherAvatar(
  teacherId: number,
  blob: Blob,
): Promise<void> {
  const form = new FormData();
  form.append("file", blob, "avatar.jpg");
  const res = await authFetch(`/api/admin/teachers/${teacherId}/avatar`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Failed to upload avatar");
}

async function uploadTeacherHero(
  teacherId: number,
  blob: Blob,
  focalX: number,
  focalY: number,
): Promise<void> {
  const form = new FormData();
  form.append("file", blob, "hero.jpg");
  form.append("focalX", String(focalX));
  form.append("focalY", String(focalY));
  const res = await authFetch(`/api/admin/teachers/${teacherId}/hero`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Failed to upload hero");
}

async function fetchUrlAsFile(url: string, filename: string): Promise<File> {
  // Likely failure mode here is CORS — the S3 bucket doesn't have a CORS
  // policy for this origin, so fetch is blocked even though <img> works
  // (image tags don't trigger CORS preflight). Log the underlying error
  // so we can diagnose if "Could not load existing" toast pops up.
  let res: Response;
  try {
    res = await fetch(url, { mode: "cors", cache: "no-cache" });
  } catch (err) {
    console.error("[fetchUrlAsFile] fetch failed (likely CORS):", err, "url:", url);
    throw err;
  }
  if (!res.ok) {
    console.error("[fetchUrlAsFile] HTTP", res.status, res.statusText, "url:", url);
    throw new Error(`HTTP ${res.status}`);
  }
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/jpeg" });
}

/** Crop the source image to the given pixel area and return a JPEG blob.
 * The output keeps the source pixel dimensions of the crop region; the
 * server's image pipeline (sharp) is what actually downsizes to the
 * canonical 1200px-wide hero, so the admin keeps full source quality
 * through the crop and the resize happens once, on the server.
 */
async function cropImageToBlob(
  file: File,
  area: { x: number; y: number; width: number; height: number },
  grayscale = false,
): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = (e) => reject(e);
      i.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = area.width;
    canvas.height = area.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2d context unavailable");
    ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
    if (grayscale) applyGrayscale(ctx, area.width, area.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode blob"))),
        "image/jpeg",
        0.95,
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function TeacherImageUpload() {
  const record = useRecordContext();
  const notify = useNotify();
  const refresh = useRefresh();

  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [savingHero, setSavingHero] = useState(false);
  const [avatarDragOver, setAvatarDragOver] = useState(false);
  const [heroDragOver, setHeroDragOver] = useState(false);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const heroInputRef = useRef<HTMLInputElement>(null);

  // ============ AVATAR ============

  const openAvatarFromFile = useCallback((file: File) => {
    setDialog({ kind: "avatar", file });
  }, []);

  const openAvatarFromExisting = useCallback(async () => {
    const url = (record?.avatarUrl || record?.photoUrl) as string | undefined;
    if (!url) {
      avatarInputRef.current?.click();
      return;
    }
    try {
      const file = await fetchUrlAsFile(url, "current-avatar.jpg");
      setDialog({ kind: "avatar", file });
    } catch {
      notify("Could not load existing avatar", { type: "warning" });
    }
  }, [record, notify]);

  const handleAvatarSave = useCallback(
    async (blob: Blob) => {
      if (!record?.id) return;
      setSavingAvatar(true);
      try {
        await uploadTeacherAvatar(record.id as number, blob);
        notify("padmakara.teachers.avatarUploaded", { type: "success" });
        setDialog({ kind: "closed" });
        refresh();
      } catch {
        notify("padmakara.teachers.avatarUploadFailed", { type: "error" });
      } finally {
        setSavingAvatar(false);
      }
    },
    [record, notify, refresh],
  );

  // ============ HERO ============

  const openHeroFromFile = useCallback((file: File) => {
    setDialog({ kind: "hero", file });
  }, []);

  const openHeroFromExisting = useCallback(async () => {
    if (!record) return;
    const url = record.heroUrl as string | undefined;
    if (!url) {
      heroInputRef.current?.click();
      return;
    }
    try {
      const file = await fetchUrlAsFile(url, "current-hero.jpg");
      setDialog({
        kind: "hero",
        file,
        initialFocal: {
          x: (record.heroFocalX as number) ?? 50,
          y: (record.heroFocalY as number) ?? 50,
        },
      });
    } catch {
      notify("Could not load existing hero", { type: "warning" });
    }
  }, [record, notify]);

  const handleHeroSave = useCallback(
    async (params: HeroSaveParams) => {
      if (!record?.id) return;
      setSavingHero(true);
      try {
        if (dialog.kind !== "hero") return;

        const blob = await cropImageToBlob(
          dialog.file,
          params.cropAreaPixels,
          params.grayscale,
        );
        await uploadTeacherHero(
          record.id as number,
          blob,
          params.focalX,
          params.focalY,
        );
        notify("padmakara.teachers.heroUploaded", { type: "success" });
        setDialog({ kind: "closed" });
        refresh();
      } catch {
        notify("padmakara.teachers.heroUploadFailed", { type: "error" });
      } finally {
        setSavingHero(false);
      }
    },
    [record, dialog, notify, refresh],
  );

  // ============ INPUT HANDLERS ============

  const handleAvatarFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) openAvatarFromFile(file);
    },
    [openAvatarFromFile],
  );

  const handleAvatarDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setAvatarDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith("image/")) openAvatarFromFile(file);
    },
    [openAvatarFromFile],
  );

  const handleHeroFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) openHeroFromFile(file);
    },
    [openHeroFromFile],
  );

  const handleHeroDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setHeroDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith("image/")) openHeroFromFile(file);
    },
    [openHeroFromFile],
  );

  if (!record) return null;

  const focalX = (record.heroFocalX as number) ?? 50;
  const focalY = (record.heroFocalY as number) ?? 50;
  const hasAvatar = !!(record.avatarUrl || record.photoUrl);
  const hasHero = !!record.heroUrl;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3, my: 2 }}>
      {/* ================= AVATAR ================= */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Avatar (circular crop)
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Box
            onDragOver={(e) => {
              e.preventDefault();
              setAvatarDragOver(true);
            }}
            onDragLeave={() => setAvatarDragOver(false)}
            onDrop={handleAvatarDrop}
            onClick={hasAvatar ? openAvatarFromExisting : () => avatarInputRef.current?.click()}
            sx={{
              width: 120,
              height: 120,
              borderRadius: "50%",
              overflow: "hidden",
              bgcolor: avatarDragOver ? "#c7d2fe" : "#e5e7eb",
              border: avatarDragOver ? "2px dashed #6366f1" : "2px dashed transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "all 0.2s",
              position: "relative",
              "&:hover .edit-overlay": { opacity: hasAvatar ? 1 : 0 },
            }}
          >
            {avatarDragOver ? (
              <Typography variant="caption" color="primary" sx={{ textAlign: "center", px: 1 }}>
                Drop to replace
              </Typography>
            ) : hasAvatar ? (
              <>
                <img
                  src={(record.avatarUrl || record.photoUrl) as string}
                  alt={record.name as string}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
                <Box
                  className="edit-overlay"
                  sx={{
                    position: "absolute",
                    inset: 0,
                    bgcolor: "rgba(0,0,0,0.4)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "white",
                    opacity: 0,
                    transition: "opacity 0.2s",
                  }}
                >
                  <EditIcon fontSize="small" sx={{ mr: 0.5 }} />
                  <Typography variant="caption">Edit</Typography>
                </Box>
              </>
            ) : (
              <Typography variant="h4" color="text.secondary">
                {((record.name as string) || "?")
                  .split(" ")
                  .map((w: string) => w[0])
                  .join("")
                  .substring(0, 2)
                  .toUpperCase()}
              </Typography>
            )}
          </Box>
          <Box>
            <Button
              variant="outlined"
              size="small"
              startIcon={savingAvatar ? <CircularProgress size={16} /> : <CloudUploadIcon />}
              disabled={savingAvatar}
              onClick={() => avatarInputRef.current?.click()}
            >
              {savingAvatar ? "Uploading..." : hasAvatar ? "Replace Avatar" : "Upload Avatar"}
            </Button>
            <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>
              {hasAvatar ? "Click image to adjust, or drag & drop a new one" : "Or drag & drop onto the circle"}
            </Typography>
            <input
              ref={avatarInputRef}
              type="file"
              hidden
              accept="image/*"
              onChange={handleAvatarFileChange}
            />
          </Box>
        </Box>
      </Box>

      {/* ================= HERO ================= */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Hero Image (full-width banner)
        </Typography>
        <Box
          onDragOver={(e) => {
            e.preventDefault();
            setHeroDragOver(true);
          }}
          onDragLeave={() => setHeroDragOver(false)}
          onDrop={handleHeroDrop}
          onClick={hasHero ? openHeroFromExisting : () => heroInputRef.current?.click()}
          sx={{
            width: "100%",
            height: 180,
            borderRadius: 1,
            overflow: "hidden",
            bgcolor: heroDragOver ? "#c7d2fe" : "#e5e7eb",
            border: heroDragOver ? "2px dashed #6366f1" : "2px dashed transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            mb: 1,
            cursor: "pointer",
            transition: "all 0.2s",
            position: "relative",
            "&:hover .edit-overlay": { opacity: hasHero ? 1 : 0 },
          }}
        >
          {heroDragOver ? (
            <Typography color="primary">Drop to replace</Typography>
          ) : hasHero ? (
            <>
              <img
                src={record.heroUrl as string}
                alt="Hero"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  objectPosition: `${focalX}% ${focalY}%`,
                }}
              />
              <Box
                className="edit-overlay"
                sx={{
                  position: "absolute",
                  inset: 0,
                  bgcolor: "rgba(0,0,0,0.4)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "white",
                  opacity: 0,
                  transition: "opacity 0.2s",
                }}
              >
                <EditIcon fontSize="small" sx={{ mr: 0.5 }} />
                <Typography variant="caption">Click to adjust</Typography>
              </Box>
            </>
          ) : (
            <Typography color="text.secondary">
              {savingHero ? "Uploading..." : "Drop hero image here or click to browse"}
            </Typography>
          )}
        </Box>
        {hasHero && (
          <Typography variant="caption" color="text.secondary">
            Focal point: {focalX}% / {focalY}%
          </Typography>
        )}
        <input
          ref={heroInputRef}
          type="file"
          hidden
          accept="image/*"
          onChange={handleHeroFileChange}
        />
      </Box>

      {/* ================= DIALOG ================= */}
      {dialog.kind === "avatar" && (
        <ImageCropDialog
          mode="avatar"
          open
          image={dialog.file}
          onClose={() => setDialog({ kind: "closed" })}
          onSave={handleAvatarSave}
          saving={savingAvatar}
        />
      )}
      {dialog.kind === "hero" && (
        <ImageCropDialog
          mode="hero"
          open
          image={dialog.file}
          onClose={() => setDialog({ kind: "closed" })}
          onSave={handleHeroSave}
          saving={savingHero}
          initialFocal={dialog.initialFocal}
        />
      )}
    </Box>
  );
}
