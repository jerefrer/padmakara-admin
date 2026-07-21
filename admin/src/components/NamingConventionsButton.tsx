import { useState } from "react";
import { useTranslate } from "react-admin";
import Button from "@mui/material/Button";
import type { SxProps, Theme } from "@mui/material/styles";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import { NamingConventionsDialog } from "./NamingConventionsDialog";

export interface NamingConventionsButtonProps {
  size?: "small" | "medium" | "large";
  variant?: "text" | "outlined" | "contained";
  sx?: SxProps<Theme>;
}

/**
 * A "Naming conventions" button that owns the guide dialog's open state, so a
 * call site is a single self-contained element (used at both the create and
 * edit audio drop zones).
 */
export function NamingConventionsButton({
  size = "small",
  variant = "text",
  sx,
}: NamingConventionsButtonProps) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        size={size}
        variant={variant}
        startIcon={<MenuBookIcon />}
        onClick={() => setOpen(true)}
        sx={sx}
      >
        {translate("padmakara.namingConventions.button") || "Naming conventions"}
      </Button>
      <NamingConventionsDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
