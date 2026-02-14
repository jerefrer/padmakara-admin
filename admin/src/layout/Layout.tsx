import Box from "@mui/material/Box";
import { AppBar, Sidebar, CheckForApplicationUpdate } from "react-admin";
import { Menu } from "./Menu";
import { LanguageSwitcher } from "../components/LanguageSwitcher";

const SIDEBAR_WIDTH = 200;

/**
 * Custom layout: full-height sidebar on the left, minimal top bar
 * above the content area only (not above the sidebar).
 */
export const Layout = ({ children }: { children: React.ReactNode }) => (
  <Box sx={{ display: "flex", minHeight: "100vh" }}>
    {/* Sidebar — full viewport height */}
    <Sidebar
      sx={{
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        height: "100vh",
        position: "sticky",
        top: 0,
        backgroundColor: "#1A1A2E",
        // Target all possible drawer-paper class names across RA versions
        "& .RaSidebar-drawerPaper, & .MuiDrawer-paper": {
          width: SIDEBAR_WIDTH,
          backgroundColor: "#1A1A2E",
          color: "rgba(255,255,255,0.85)",
          borderRight: "none",
          position: "relative",
        },
        // Ensure fixed wrapper fills the full drawer width
        "& .RaSidebar-fixed": {
          width: SIDEBAR_WIDTH,
        },
        // Never collapse
        "&.RaSidebar-closed .RaSidebar-drawerPaper, &.RaSidebar-closed .MuiDrawer-paper": {
          width: SIDEBAR_WIDTH,
        },
      }}
    >
      <Menu />
    </Sidebar>

    {/* Right side: top bar + content */}
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0 }}>
      {/* Minimal top bar */}
      <AppBar
        color="inherit"
        elevation={0}
        toolbar={<LanguageSwitcher />}
        sx={{
          position: "static",
          boxShadow: "none",
          backgroundColor: "#FFFFFF",
          borderBottom: "1px solid rgba(0,0,0,0.06)",
          "& .RaAppBar-toolbar": {
            minHeight: "48px !important",
            padding: "0 16px !important",
          },
          "& .RaAppBar-menuButton": { display: "none" },
        }}
      >
        <Box sx={{ flex: 1 }} />
      </AppBar>

      {/* Page content */}
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          p: 3,
          backgroundColor: "background.default",
          overflow: "auto",
        }}
      >
        {children}
      </Box>
    </Box>
    <CheckForApplicationUpdate />
  </Box>
);
