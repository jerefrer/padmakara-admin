import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { AppBar, Sidebar, CheckForApplicationUpdate, useResourceDefinitions, useGetResourceLabel } from "react-admin";
import { useLocation } from "react-router-dom";
import { Menu } from "./Menu";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { IncompleteAudioBanner } from "../components/IncompleteAudioBanner";

function PageTitle() {
  const location = useLocation();
  const resourceDefinitions = useResourceDefinitions();
  const getResourceLabel = useGetResourceLabel();

  // Parse current path: /resource or /resource/:id
  const path = location.pathname.replace(/^\/+/, "");
  const segments = path.split("/");
  const resourceName = segments[0] || "";
  const recordId = segments[1];
  const isEdit = !!recordId && recordId !== "create";
  const isCreate = recordId === "create";

  if (!resourceName || !resourceDefinitions[resourceName]) {
    return <Box sx={{ flex: 1 }} />;
  }

  const label = getResourceLabel(resourceName, 2);

  return (
    <Box sx={{ flex: 1, display: "flex", alignItems: "center", gap: 1 }}>
      <Typography
        variant="body1"
        sx={{ fontWeight: 600, color: "text.primary" }}
      >
        {label}
      </Typography>
      {(isEdit || isCreate) && (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          / {isCreate ? "New" : `#${recordId}`}
        </Typography>
      )}
    </Box>
  );
}

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
        <PageTitle />
      </AppBar>

      {/* Global alert: events with unfinished audio uploads */}
      <IncompleteAudioBanner />

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
