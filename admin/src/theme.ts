import { defaultTheme } from "react-admin";
import { createTheme } from "@mui/material/styles";

/**
 * Padmakara Admin Theme
 *
 * A warm, modern design inspired by Buddhist aesthetics —
 * muted indigo primary, earthy amber accents, generous whitespace.
 */

const palette = {
  primary: {
    main: "#5B5EA6",
    light: "#8385C2",
    dark: "#3D4076",
    contrastText: "#FFFFFF",
  },
  secondary: {
    main: "#D4A853",
    light: "#E4C47A",
    dark: "#B8893A",
    contrastText: "#1A1A2E",
  },
  background: {
    default: "#F5F5F0",
    paper: "#FFFFFF",
  },
  text: {
    primary: "#1A1A2E",
    secondary: "#6B7280",
  },
  error: {
    main: "#DC6B6B",
  },
  success: {
    main: "#6BAF8D",
  },
  warning: {
    main: "#D4A853",
  },
  info: {
    main: "#5B5EA6",
  },
  divider: "rgba(0,0,0,0.06)",
};

export const theme = createTheme({
  ...defaultTheme,
  palette,
  typography: {
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    h1: { fontWeight: 700, letterSpacing: "-0.02em" },
    h2: { fontWeight: 700, letterSpacing: "-0.02em" },
    h3: { fontWeight: 600, letterSpacing: "-0.01em" },
    h4: { fontWeight: 600, letterSpacing: "-0.01em" },
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600, fontSize: "1.05rem" },
    subtitle1: { fontWeight: 500, color: palette.text.secondary },
    subtitle2: { fontWeight: 500, fontSize: "0.8rem", color: palette.text.secondary, textTransform: "uppercase", letterSpacing: "0.08em" },
    body1: { fontSize: "0.9rem", lineHeight: 1.6 },
    body2: { fontSize: "0.825rem", lineHeight: 1.5 },
    button: { fontWeight: 600, textTransform: "none", letterSpacing: "0.01em" },
  },
  shape: {
    borderRadius: 10,
  },
  components: {
    // --- Global ---
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: palette.background.default,
        },
      },
    },

    // --- Cards & Paper ---
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
        elevation1: {
          boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06)",
        },
      },
      defaultProps: { elevation: 0 },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          border: "1px solid rgba(0,0,0,0.06)",
          borderRadius: 12,
          overflow: "hidden",
        },
      },
    },

    // --- App Bar (only affects RA's AppBar when used inside custom Layout) ---
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: "transparent",
          color: palette.text.primary,
          boxShadow: "none",
        },
      },
    },

    // --- Buttons ---
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          padding: "8px 18px",
          fontWeight: 600,
        },
        contained: {
          boxShadow: "none",
          "&:hover": { boxShadow: "0 2px 8px rgba(91,94,166,0.3)" },
        },
        outlined: {
          borderWidth: 1.5,
        },
      },
      defaultProps: {
        disableElevation: true,
      },
    },
    MuiFab: {
      styleOverrides: {
        root: {
          boxShadow: "0 4px 14px rgba(91,94,166,0.35)",
        },
      },
    },

    // --- Inputs ---
    MuiTextField: {
      defaultProps: {
        variant: "outlined",
        size: "small",
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          "&:hover .MuiOutlinedInput-notchedOutline": {
            borderColor: palette.primary.light,
          },
        },
        notchedOutline: {
          borderColor: "rgba(0,0,0,0.12)",
        },
      },
    },

    // --- Table ---
    MuiTableHead: {
      styleOverrides: {
        root: {
          "& .MuiTableCell-head": {
            fontWeight: 600,
            fontSize: "0.75rem",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: palette.text.secondary,
            backgroundColor: "rgba(0,0,0,0.02)",
            borderBottom: "2px solid rgba(0,0,0,0.06)",
            padding: "10px 16px",
          },
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: {
          "&:last-child td": { borderBottom: 0 },
          "&:hover": {
            backgroundColor: "rgba(91,94,166,0.03) !important",
          },
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: "1px solid rgba(0,0,0,0.04)",
          padding: "12px 16px",
          fontSize: "0.85rem",
        },
      },
    },

    // --- Chips ---
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 6,
          fontWeight: 500,
          fontSize: "0.78rem",
        },
        colorPrimary: {
          backgroundColor: "rgba(91,94,166,0.1)",
          color: palette.primary.dark,
        },
      },
    },

    // --- Sidebar / Drawer ---
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: "#1A1A2E",
          color: "rgba(255,255,255,0.85)",
          borderRight: "none",
        },
      },
    },

    // --- Menu Items in Sidebar ---
    MuiMenuItem: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          margin: "2px 12px",
          padding: "8px 12px",
          "&.Mui-selected": {
            backgroundColor: "rgba(91,94,166,0.15)",
          },
        },
      },
    },
    MuiListItemIcon: {
      styleOverrides: {
        root: {
          color: "inherit",
          minWidth: 36,
        },
      },
    },
    MuiListItemText: {
      styleOverrides: {
        primary: {
          fontSize: "0.88rem",
          fontWeight: 500,
        },
      },
    },

    // --- Tooltip ---
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: palette.text.primary,
          fontSize: "0.78rem",
          borderRadius: 6,
          padding: "6px 12px",
        },
      },
    },

    // --- React Admin overrides ---
    RaDatagrid: {
      styleOverrides: {
        root: {
          "& .RaDatagrid-headerCell": {
            fontWeight: 600,
          },
        },
      },
    } as any,

    RaMenuItemLink: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          margin: "2px 12px",
          color: "rgba(255,255,255,0.7)",
          "&:hover": {
            backgroundColor: "rgba(255,255,255,0.08)",
            color: "#FFFFFF",
          },
          "&.RaMenuItemLink-active": {
            backgroundColor: "rgba(91,94,166,0.25)",
            color: "#FFFFFF",
            fontWeight: 600,
          },
        },
      },
    } as any,

    RaSidebar: {
      styleOverrides: {
        root: {
          "& .RaSidebar-drawerPaper": {
            backgroundColor: "#1A1A2E",
          },
        },
      },
    } as any,

    RaList: {
      styleOverrides: {
        root: {
          "& .RaList-main": {
            "& > .MuiToolbar-root": {
              padding: "8px 0",
              minHeight: "auto",
            },
          },
        },
      },
    } as any,
  },
});
