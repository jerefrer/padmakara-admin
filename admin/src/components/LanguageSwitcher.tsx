import { useLocaleState } from "react-admin";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import ToggleButton from "@mui/material/ToggleButton";

export const LanguageSwitcher = () => {
  const [locale, setLocale] = useLocaleState();
  return (
    <ToggleButtonGroup
      value={locale}
      exclusive
      onChange={(_, v) => { if (v) setLocale(v); }}
      size="small"
      sx={{
        "& .MuiToggleButton-root": {
          px: 1.5,
          py: 0.25,
          fontSize: "0.75rem",
          fontWeight: 600,
          lineHeight: 1.5,
          borderColor: "rgba(0,0,0,0.12)",
          "&.Mui-selected": {
            bgcolor: "primary.main",
            color: "white",
            "&:hover": { bgcolor: "primary.dark" },
          },
        },
      }}
    >
      <ToggleButton value="en">EN</ToggleButton>
      <ToggleButton value="pt">PT</ToggleButton>
    </ToggleButtonGroup>
  );
};
