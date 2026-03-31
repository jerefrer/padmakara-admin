import { useState, useCallback } from "react";
import { useRecordContext, useDataProvider, useNotify } from "react-admin";
import { Box, Button, Typography, CircularProgress } from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import { AvatarCropDialog } from "./AvatarCropDialog";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

async function presignUpload(
  teacherId: number,
  type: "avatar" | "hero",
  filename: string,
  contentType: string,
): Promise<{ s3Key: string; uploadUrl: string }> {
  const res = await fetch(`${API_URL}/api/admin/teachers/presign-upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [cropDialogOpen, setCropDialogOpen] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [savingHero, setSavingHero] = useState(false);

  const handleAvatarSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAvatarFile(file);
      setCropDialogOpen(true);
    }
    e.target.value = "";
  }, []);

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
        notify("Avatar uploaded", { type: "success" });
        setCropDialogOpen(false);
        setAvatarFile(null);
      } catch (err) {
        notify("Avatar upload failed", { type: "error" });
      } finally {
        setSavingAvatar(false);
      }
    },
    [record, dataProvider, notify],
  );

  const handleHeroSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !record?.id) return;
      e.target.value = "";
      setSavingHero(true);
      try {
        const { s3Key, uploadUrl } = await presignUpload(record.id as number, "hero", file.name, file.type || "image/jpeg");
        await uploadToS3(uploadUrl, file, file.type || "image/jpeg");
        await dataProvider.update("teachers", {
          id: record.id,
          data: { ...record, heroS3Key: s3Key },
          previousData: record,
        });
        notify("Hero image uploaded", { type: "success" });
      } catch (err) {
        notify("Hero upload failed", { type: "error" });
      } finally {
        setSavingHero(false);
      }
    },
    [record, dataProvider, notify],
  );

  if (!record) return null;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3, my: 2 }}>
      {/* Avatar Section */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>Avatar (circular crop)</Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <Box sx={{ width: 120, height: 120, borderRadius: "50%", overflow: "hidden", bgcolor: "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {(record.avatarUrl || record.photoUrl) ? (
              <img src={(record.avatarUrl || record.photoUrl) as string} alt={record.name as string} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <Typography variant="h4" color="text.secondary">
                {((record.name as string) || "?").split(" ").map((w: string) => w[0]).join("").substring(0, 2).toUpperCase()}
              </Typography>
            )}
          </Box>
          <Button component="label" variant="outlined" startIcon={savingAvatar ? <CircularProgress size={16} /> : <CloudUploadIcon />} disabled={savingAvatar}>
            {savingAvatar ? "Uploading..." : "Upload Avatar"}
            <input type="file" hidden accept="image/*" onChange={handleAvatarSelect} />
          </Button>
        </Box>
      </Box>

      {/* Hero Section */}
      <Box>
        <Typography variant="subtitle2" gutterBottom>Hero Image (full-width banner)</Typography>
        <Box sx={{ width: "100%", height: 160, borderRadius: 1, overflow: "hidden", bgcolor: "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", mb: 1 }}>
          {record.heroUrl ? (
            <img src={record.heroUrl as string} alt="Hero" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <Typography color="text.secondary">No hero image</Typography>
          )}
        </Box>
        <Button component="label" variant="outlined" startIcon={savingHero ? <CircularProgress size={16} /> : <CloudUploadIcon />} disabled={savingHero}>
          {savingHero ? "Uploading..." : "Upload Hero Image"}
          <input type="file" hidden accept="image/*" onChange={handleHeroSelect} />
        </Button>
      </Box>

      <AvatarCropDialog open={cropDialogOpen} image={avatarFile} onClose={() => { setCropDialogOpen(false); setAvatarFile(null); }} onSave={handleAvatarCropSave} saving={savingAvatar} />
    </Box>
  );
}
