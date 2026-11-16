import { useState, useCallback, useRef } from "react";
import { useRecordContext, useNotify, useRefresh } from "react-admin";
import { Box, Button, Typography, CircularProgress } from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { HeroFramePreviews } from "./HeroFramePreviews";
import { HERO_DESKTOP_WIDTH } from "../utils/heroResolution";
import { ImageCropDialog, applyGrayscale, type HeroSaveParams } from "./ImageCropDialog";
import { authFetch } from "../utils/authFetch";
import { fetchImageSourceAsFile } from "../utils/imageSource";
import { readHeroFrameOverrides } from "../utils/heroFrameOverrides";
import { appendHeroEdit, storedHeroEdit, type HeroEditUpload, type StoredHeroEdit } from "../utils/heroEdit";

type DialogState =
  | { kind: "closed" }
  | { kind: "avatar"; file: File }
  | {
      kind: "hero";
      file: File;
      initialFocal?: { x: number; y: number };
    } & StoredHeroEdit;

async function uploadAvatar(resource: string, recordId: number, blob: Blob): Promise<void> {
  const form = new FormData();
  form.append("file", blob, "avatar.jpg");
  const res = await authFetch(`/api/admin/${resource}/${recordId}/avatar`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Failed to upload avatar");
}

async function uploadHero(
  resource: string,
  recordId: number,
  blob: Blob,
  focalX: number,
  focalY: number,
  edit: HeroEditUpload,
): Promise<void> {
  const form = new FormData();
  form.append("file", blob, "hero.jpg");
  form.append("focalX", String(focalX));
  form.append("focalY", String(focalY));
  appendHeroEdit(form, edit);
  const res = await authFetch(`/api/admin/${resource}/${recordId}/hero`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Failed to upload hero");
}

/**
 * Crop the source image to the given pixel area and return a JPEG blob.
 * The output keeps the source pixel dimensions of the crop region; the
 * server's image pipeline (sharp) downsizes to 1200px wide, so the admin
 * keeps full source quality through the crop and the resize happens once.
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

export interface ImageSetUploadProps {
  /** Admin API resource the images belong to: `/api/admin/{resource}/:id/{avatar,hero}`. */
  resource: "groups" | "events";
  /** The record; defaults to the react-admin record context. */
  record?: Record<string, unknown>;
  /** Show the separate square avatar editor. Events derive the avatar from the hero instead. */
  showAvatar?: boolean;
  heroTitle?: string;
  heroDropLabel?: string;
  heroUploadLabel?: string;
  heroReplaceLabel?: string;
  /** Hint under the hero editor. */
  hint?: string;
  /** When set, a remove button deletes the images through DELETE `/api/admin/{resource}/:id/{removePath}`. */
  removePath?: string;
  removeLabel?: string;
  /** Called after any change, so the owner can refresh what it shows. */
  onChanged?: () => void;
}

/**
 * Avatar + hero image editor with crop, black-and-white, stored original and per-frame framing.
 * Shared by retreat groups (GroupImageUpload) and the event photo (EventPhotoSection).
 */
export function ImageSetUpload({
  resource,
  record: recordProp,
  showAvatar = true,
  heroTitle = "Hero image (as it appears in the app)",
  heroDropLabel = "Drop hero image here or click to browse",
  heroUploadLabel = "Upload Hero",
  heroReplaceLabel = "Replace Hero",
  hint,
  removePath,
  removeLabel = "Remove",
  onChanged,
}: ImageSetUploadProps) {
  const contextRecord = useRecordContext();
  const record = recordProp ?? contextRecord;
  const i18nResource = resource;
  const notify = useNotify();
  const refresh = useRefresh();

  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [savingHero, setSavingHero] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [avatarDragOver, setAvatarDragOver] = useState(false);
  const [heroDragOver, setHeroDragOver] = useState(false);

  const avatarInputRef = useRef<HTMLInputElement>(null);
  const heroInputRef = useRef<HTMLInputElement>(null);

  // ============ AVATAR ============

  const openAvatarFromFile = useCallback((file: File) => {
    setDialog({ kind: "avatar", file });
  }, []);

  const openAvatarFromExisting = useCallback(async () => {
    const hasExisting = !!(record?.avatarUrl || record?.logoUrl);
    if (!record?.id || !hasExisting) {
      avatarInputRef.current?.click();
      return;
    }
    try {
      const file = await fetchImageSourceAsFile(
        `/api/admin/${resource}/${record.id}/avatar/source`,
        "current-avatar.jpg",
      );
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
        await uploadAvatar(resource, record.id as number, blob);
        notify(`padmakara.${i18nResource}.avatarUploaded`, { type: "success" });
        setDialog({ kind: "closed" });
        refresh();
        onChanged?.();
      } catch {
        notify(`padmakara.${i18nResource}.avatarUploadFailed`, { type: "error" });
      } finally {
        setSavingAvatar(false);
      }
    },
    [record, resource, i18nResource, notify, refresh, onChanged],
  );

  // ============ HERO ============

  const openHeroFromFile = useCallback((file: File) => {
    setDialog({ kind: "hero", file, storedOriginal: false });
  }, []);

  const openHeroFromExisting = useCallback(async () => {
    if (!record?.id) return;
    if (!record.heroUrl) {
      heroInputRef.current?.click();
      return;
    }
    try {
      const file = await fetchImageSourceAsFile(
        `/api/admin/${resource}/${record.id}/hero/source`,
        "current-hero.jpg",
      );
      setDialog({
        kind: "hero",
        file,
        ...storedHeroEdit(record),
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
      if (!record?.id || dialog.kind !== "hero") return;
      setSavingHero(true);
      try {
        const blob = await cropImageToBlob(
          dialog.file,
          params.cropAreaPixels,
          params.grayscale,
        );
        await uploadHero(
          resource,
          record.id as number,
          blob,
          params.focalX,
          params.focalY,
          {
            original: dialog.storedOriginal ? null : dialog.file,
            crop: params.cropAreaPixels,
            grayscale: params.grayscale,
            frameOverrides: params.frameOverrides,
          },
        );
        notify(`padmakara.${i18nResource}.heroUploaded`, { type: "success" });
        setDialog({ kind: "closed" });
        refresh();
        onChanged?.();
      } catch {
        notify(`padmakara.${i18nResource}.heroUploadFailed`, { type: "error" });
      } finally {
        setSavingHero(false);
      }
    },
    [record, dialog, resource, i18nResource, notify, refresh, onChanged],
  );

  // ============ REMOVE ============

  const handleRemove = useCallback(async () => {
    if (!record?.id || !removePath) return;
    setRemoving(true);
    try {
      const res = await authFetch(`/api/admin/${resource}/${record.id}/${removePath}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove");
      notify(`padmakara.${i18nResource}.photoRemoved`, { type: "success" });
      refresh();
      onChanged?.();
    } catch {
      notify(`padmakara.${i18nResource}.photoRemoveFailed`, { type: "error" });
    } finally {
      setRemoving(false);
    }
  }, [record, removePath, resource, i18nResource, notify, refresh, onChanged]);

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
  const hasAvatar = !!(record.avatarUrl || record.logoUrl);
  const hasHero = !!record.heroUrl;
  const groupName = (record.nameEn || record.titleEn || "?") as string;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3, my: 2 }}>
      {/* ================= AVATAR ================= */}
      {showAvatar && (
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Avatar (small thumbnail, square)
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
              borderRadius: 2,
              overflow: "hidden",
              bgcolor: avatarDragOver ? "#f3d9d9" : "#e5e7eb",
              border: avatarDragOver ? "2px dashed #9b1b1b" : "2px dashed transparent",
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
                  src={(record.avatarUrl || record.logoUrl) as string}
                  alt={groupName}
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
                {groupName
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
              {hasAvatar ? "Click image to adjust, or drag & drop a new one" : "Or drag & drop onto the box"}
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

      )}

      {/* ================= HERO ================= */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>
          {heroTitle}
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
            height: hasHero && !heroDragOver ? "auto" : 180,
            py: hasHero && !heroDragOver ? 2 : 0,
            borderRadius: 1,
            overflow: "hidden",
            bgcolor: heroDragOver ? "#f3d9d9" : "#e5e7eb",
            border: heroDragOver ? "2px dashed #9b1b1b" : "2px dashed transparent",
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
              <HeroFramePreviews
                imageUrl={record.heroUrl as string}
                crop="whole"
                focal={{ x: focalX, y: focalY }}
                grayscale={false}
                overrides={readHeroFrameOverrides(record.heroFrameOverrides)}
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
              {savingHero ? "Uploading..." : heroDropLabel}
            </Typography>
          )}
        </Box>
        {hasHero && (
          <Typography variant="caption" color="text.secondary">
            Focal point: {focalX}% / {focalY}%
          </Typography>
        )}
        <Box sx={{ mt: 1 }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={savingHero ? <CircularProgress size={16} /> : <CloudUploadIcon />}
            disabled={savingHero}
            onClick={() => heroInputRef.current?.click()}
          >
            {savingHero ? "Uploading..." : hasHero ? heroReplaceLabel : heroUploadLabel}
          </Button>
          <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>
            {hasHero ? "Click the previews to adjust, or drag & drop a new photo. " : ""}
            Any file size works: the app gets a compressed copy. Prefer photos at least {HERO_DESKTOP_WIDTH} px wide.
          </Typography>
          {hint && (
            <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>
              {hint}
            </Typography>
          )}
          {removePath && hasHero && (
            <Button
              variant="text"
              color="error"
              size="small"
              startIcon={removing ? <CircularProgress size={16} /> : <DeleteOutlineIcon />}
              disabled={removing || savingHero}
              onClick={handleRemove}
              sx={{ mt: 1 }}
            >
              {removeLabel}
            </Button>
          )}
        </Box>
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
          initialCrop={dialog.initialCrop}
          initialGrayscale={dialog.initialGrayscale}
          initialFrameOverrides={dialog.initialFrameOverrides}
        />
      )}
    </Box>
  );
}
