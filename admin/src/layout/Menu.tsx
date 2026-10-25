import { Menu as RaMenu, useTranslate } from "react-admin";
import SpaIcon from "@mui/icons-material/SelfImprovement";
import GroupsIcon from "@mui/icons-material/Groups";
import PersonIcon from "@mui/icons-material/Person";
import PlaceIcon from "@mui/icons-material/Place";
import BusinessIcon from "@mui/icons-material/Business";
import PeopleIcon from "@mui/icons-material/People";
import CategoryIcon from "@mui/icons-material/Category";
import PeopleOutlineIcon from "@mui/icons-material/PeopleOutline";
import HowToRegIcon from "@mui/icons-material/HowToReg";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import LibraryBooksIcon from "@mui/icons-material/LibraryBooks";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";

export const Menu = () => {
  const translate = useTranslate();
  return (
    <Box sx={{ pt: 1 }}>
      {/* Brand: the same logo + wordmark lockup as the app's desktop sidebar */}
      <Box sx={{ px: 2, pt: 2, pb: 2.5, mb: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Box
          component="img"
          src="/images/padmakara-logo.png"
          alt=""
          sx={{ width: 72, height: 72, mb: 1.5, opacity: 0.85 }}
        />
        <Typography
          sx={{
            color: "#FFFFFF",
            fontFamily: '"EB Garamond", serif',
            fontWeight: 400,
            fontSize: "1.3rem",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            lineHeight: 1.2,
          }}
        >
          {translate("padmakara.brand.title")}
        </Typography>
        <Typography
          variant="caption"
          sx={{
            color: "rgba(255,255,255,0.6)",
            fontSize: "0.65rem",
            fontWeight: 600,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            mt: 0.5,
          }}
        >
          {translate("padmakara.brand.subtitle")}
        </Typography>
      </Box>

      <Divider sx={{ borderColor: "rgba(255,255,255,0.08)", mb: 1 }} />

      {/* Content section */}
      <SectionLabel>{translate("padmakara.menu.content")}</SectionLabel>
      <RaMenu.Item to="/events" primaryText={translate("resources.events.name", { smart_count: 2 })} leftIcon={<SpaIcon />} />
      <RaMenu.Item to="/publications" primaryText={translate("resources.publications.name", { smart_count: 2 })} leftIcon={<MenuBookIcon />} />

      <Divider sx={{ borderColor: "rgba(255,255,255,0.08)", my: 1.5, mx: 2 }} />

      {/* Reference data */}
      <SectionLabel>{translate("padmakara.menu.reference")}</SectionLabel>
      <RaMenu.Item to="/teachers" primaryText={translate("resources.teachers.name", { smart_count: 2 })} leftIcon={<PersonIcon />} />
      <RaMenu.Item to="/places" primaryText={translate("resources.places.name", { smart_count: 2 })} leftIcon={<PlaceIcon />} />
      <RaMenu.Item to="/organizers" primaryText={translate("resources.organizers.name", { smart_count: 2 })} leftIcon={<BusinessIcon />} />
      <RaMenu.Item to="/groups" primaryText={translate("resources.groups.name", { smart_count: 2 })} leftIcon={<GroupsIcon />} />
      <RaMenu.Item to="/event-types" primaryText={translate("resources.event-types.name", { smart_count: 2 })} leftIcon={<CategoryIcon />} />
      <RaMenu.Item to="/audiences" primaryText={translate("resources.audiences.name", { smart_count: 2 })} leftIcon={<PeopleOutlineIcon />} />

      <Divider sx={{ borderColor: "rgba(255,255,255,0.08)", my: 1.5, mx: 2 }} />

      {/* Admin */}
      <SectionLabel>{translate("padmakara.menu.administration")}</SectionLabel>
      <RaMenu.Item to="/users" primaryText={translate("resources.users.name", { smart_count: 2 })} leftIcon={<PeopleIcon />} />
      <RaMenu.Item to="/library" primaryText={translate("padmakara.library.menu")} leftIcon={<LibraryBooksIcon />} />
      <RaMenu.Item to="/approvals" primaryText={translate("resources.approvals.name", { smart_count: 2 })} leftIcon={<HowToRegIcon />} />
    </Box>
  );
};

const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <Typography
    variant="overline"
    sx={{
      px: 2,
      py: 0.5,
      display: "block",
      color: "rgba(255,255,255,0.55)",
      fontSize: "0.65rem",
      fontWeight: 600,
      letterSpacing: "0.1em",
    }}
  >
    {children}
  </Typography>
);
