import { useState, useCallback, useRef } from "react";
import { useRecordContext, useDataProvider, useNotify, useRefresh } from "react-admin";
import { Box, Button, Typography, CircularProgress } from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import { AvatarCropDialog } from "./AvatarCropDialog";

async function presignUpload(
  teacherId: number,
  type: "avatar" | "hero",
  filename: string,
  contentType: string,
): Promise<{ s3Key: string; uploadUrl: string }> {
  const token = localStorage.getItem("accessToken");
  const res = await fetch(`/api/admin/teachers/presign-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ teacherId, type, contentType, filename }),
  });
  if (!res.ok) throw new Error("Failed to get upload URL");
  return res.json();
}

async function uploadToS3(uploadUrl: string, blob: Blob, contentType: string): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: blob,
  });
  if (!res.ok) throw new Error("Failed to upload to S3");
}

export function TeacherImageUpload() {
  const record = useRecordContext();
  const dataProvider = useDataProvider();
  const notify = useNotify();
  const refresh = useRefresh();

  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [cropDialogOpen, setCropDialogOpen] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [savingHero, setSavingHero] = useState(false);
  const [avatarDragOver, setAvatarDragOver] = useState(false);
  const [heroDragOver, setHeroDragOver] = useState(false);
  const [detectingFace, setDetectingFace] = useState(false);
  const [facePosition, setFacePosition] = useState<{ x: number; y: number } | undefined>(undefined);
  const [faceScale, setFaceScale] = useState<number | undefined>(undefined);
  const heroInputRef = useRef<HTMLInputElement>(null);

  const openAvatarCrop = useCallback(async (file: File) => {
    setAvatarFile(file);
    setFacePosition(undefined);
    setFaceScale(undefined);
    setCropDialogOpen(true);
    setDetectingFace(true);

    try {
      const token = localStorage.getItem("accessToken");
      const formData = new FormData();
      formData.append("image", file);
      const res = await fetch(`/api/admin/teachers/detect-face`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        setFacePosition({ x: data.centerX, y: data.centerY });
        setFaceScale(data.suggestedScale);
      }
    } catch {
      // Fall back to default centering
    } finally {
      setDetectingFace(false);
    }
  }, []);

  const handleAvatarSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) openAvatarCrop(file);
    e.target.value = "";
  }, [openAvatarCrop]);

  const handleAvatarDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setAvatarDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) openAvatarCrop(file);
  }, [openAvatarCrop]);

  const handleAvatarCropSave = useCallback(
    async (blob: Blob) => {
      if (!record?.id) return;
      setSavingAvatar(true);
      try {
        const { s3Key, uploadUrl } = await presignUpload(record.id as number, "avatar", "avatar.jpg", "image/jpeg");
        await uploadToS3(uploadUrl, blob, "image/jpeg");
        await dataProvider.update("teachers", {
          id: record.id,
          data: { ...record, avatarS3Key: s3Key },
          previousData: record,
        });
        notify("padmakara.teachers.avatarUploaded", { type: "success" });
        setCropDialogOpen(false);
        setAvatarFile(null);
        refresh();
      } catch (err) {
        notify("padmakara.teachers.avatarUploadFailed", { type: "error" });
      } finally {
        setSavingAvatar(false);
      }
    },
    [record, dataProvider, notify, refresh],
  );

  const uploadHero = useCallback(
    async (file: File) => {
      if (!record?.id) return;
      setSavingHero(true);
      try {
        const { s3Key, uploadUrl } = await presignUpload(record.id as number, "hero", file.name, file.type || "image/jpeg");
        await uploadToS3(uploadUrl, file, file.type || "image/jpeg");

        // Server auto-detects focal point when heroS3Key changes
        await dataProvider.update("teachers", {
          id: record.id,
          data: { ...record, heroS3Key: s3Key },
          previousData: record,
        });
        notify("padmakara.teachers.heroUploaded", { type: "success" });
        refresh();
      } catch (err) {
        notify("padmakara.teachers.heroUploadFailed", { type: "error" });
      } finally {
        setSavingHero(false);
      }
    },
    [record, dataProvider, notify, refresh],
  );

  const handleHeroSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";
      uploadHero(file);
    },
    [uploadHero],
  );

  const handleHeroDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setHeroDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) uploadHero(file);
  }, [uploadHero]);

  if (!record) return null;

  const focalX = (record.heroFocalX as number) ?? 50;
  const focalY = (record.heroFocalY as number) ?? 50;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3, my: 2 }}>
      {/* Avatar Section */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>Avatar (circular crop)</Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Box
            onDragOver={(e) => { e.preventDefault(); setAvatarDragOver(true); }}
            onDragLeave={() => setAvatarDragOver(false)}
            onDrop={handleAvatarDrop}
            sx={{
              width: 120, height: 120, borderRadius: "50%", overflow: "hidden",
              bgcolor: avatarDragOver ? "#c7d2fe" : "#e5e7eb",
              border: avatarDragOver ? "2px dashed #6366f1" : "2px dashed transparent",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", transition: "all 0.2s",
            }}
            onClick={() => document.getElementById("avatar-file-input")?.click()}
          >
            {avatarDragOver ? (
              <Typography variant="caption" color="primary" sx={{ textAlign: "center", px: 1 }}>Drop image</Typography>
            ) : (record.avatarUrl || record.photoUrl) ? (
              <img src={(record.avatarUrl || record.photoUrl) as string} alt={record.name as string} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <Typography variant="h4" color="text.secondary">
                {((record.name as string) || "?").split(" ").map((w: string) => w[0]).join("").substring(0, 2).toUpperCase()}
              </Typography>
            )}
          </Box>
          <Box>
            <Button component="label" variant="outlined" size="small" startIcon={savingAvatar ? <CircularProgress size={16} /> : <CloudUploadIcon />} disabled={savingAvatar}>
              {savingAvatar ? "Uploading..." : "Upload Avatar"}
              <input id="avatar-file-input" type="file" hidden accept="image/*" onChange={handleAvatarSelect} />
            </Button>
            <Typography variant="caption" display="block" color="text.secondary" sx={{ mt: 0.5 }}>or drag & drop onto the circle</Typography>
          </Box>
        </Box>
      </Box>

      {/* Hero Section */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>Hero Image (full-width banner)</Typography>
        <Box
          onDragOver={(e) => { e.preventDefault(); setHeroDragOver(true); }}
          onDragLeave={() => setHeroDragOver(false)}
          onDrop={handleHeroDrop}
          onClick={() => heroInputRef.current?.click()}
          sx={{
            width: "100%", height: 160, borderRadius: 1, overflow: "hidden",
            bgcolor: heroDragOver ? "#c7d2fe" : "#e5e7eb",
            border: heroDragOver ? "2px dashed #6366f1" : "2px dashed transparent",
            display: "flex", alignItems: "center", justifyContent: "center", mb: 1,
            cursor: "pointer", transition: "all 0.2s",
          }}
        >
          {heroDragOver ? (
            <Typography color="primary">Drop image here</Typography>
          ) : record.heroUrl ? (
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
          ) : (
            <Typography color="text.secondary">Drop hero image here or click to browse</Typography>
          )}
        </Box>
        {record.heroUrl && (
          <Typography variant="caption" color="text.secondary">
            Focal point: {focalX}% / {focalY}%
          </Typography>
        )}
        <input ref={heroInputRef} type="file" hidden accept="image/*" onChange={handleHeroSelect} />
      </Box>

      <AvatarCropDialog open={cropDialogOpen} image={avatarFile} onClose={() => { setCropDialogOpen(false); setAvatarFile(null); }} onSave={handleAvatarCropSave} saving={savingAvatar} detecting={detectingFace} initialPosition={facePosition} initialScale={faceScale} />
    </Box>
  );
}
