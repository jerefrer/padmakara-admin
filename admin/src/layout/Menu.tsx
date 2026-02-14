import { Menu as RaMenu, useTranslate } from "react-admin";
import SpaIcon from "@mui/icons-material/SelfImprovement";
import GroupsIcon from "@mui/icons-material/Groups";
import PersonIcon from "@mui/icons-material/Person";
import PlaceIcon from "@mui/icons-material/Place";
import PeopleIcon from "@mui/icons-material/People";
import CategoryIcon from "@mui/icons-material/Category";
import PeopleOutlineIcon from "@mui/icons-material/PeopleOutline";
import HowToRegIcon from "@mui/icons-material/HowToReg";
import SyncAltIcon from "@mui/icons-material/SyncAlt";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";

export const Menu = () => {
  const translate = useTranslate();
  return (
    <Box sx={{ pt: 1 }}>
      {/* Brand */}
      <Box sx={{ px: 2, py: 2, mb: 1 }}>
        <Typography
          variant="h6"
          sx={{
            color: "rgba(255,255,255,0.95)",
            fontWeight: 700,
            fontSize: "1.15rem",
            letterSpacing: "-0.02em",
          }}
        >
          {translate("padmakara.brand.title")}
        </Typography>
        <Typography
          variant="caption"
          sx={{
            color: "rgba(255,255,255,0.4)",
            fontSize: "0.7rem",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {translate("padmakara.brand.subtitle")}
        </Typography>
      </Box>

      <Divider sx={{ borderColor: "rgba(255,255,255,0.08)", mb: 1 }} />

      {/* Content section */}
      <SectionLabel>{translate("padmakara.menu.content")}</SectionLabel>
      <RaMenu.Item to="/events" primaryText={translate("resources.events.name", { smart_count: 2 })} leftIcon={<SpaIcon />} />

      <Divider sx={{ borderColor: "rgba(255,255,255,0.08)", my: 1.5, mx: 2 }} />

      {/* Reference data */}
      <SectionLabel>{translate("padmakara.menu.reference")}</SectionLabel>
      <RaMenu.Item to="/teachers" primaryText={translate("resources.teachers.name", { smart_count: 2 })} leftIcon={<PersonIcon />} />
      <RaMenu.Item to="/places" primaryText={translate("resources.places.name", { smart_count: 2 })} leftIcon={<PlaceIcon />} />
      <RaMenu.Item to="/groups" primaryText={translate("resources.groups.name", { smart_count: 2 })} leftIcon={<GroupsIcon />} />
      <RaMenu.Item to="/event-types" primaryText={translate("resources.event-types.name", { smart_count: 2 })} leftIcon={<CategoryIcon />} />
      <RaMenu.Item to="/audiences" primaryText={translate("resources.audiences.name", { smart_count: 2 })} leftIcon={<PeopleOutlineIcon />} />

      <Divider sx={{ borderColor: "rgba(255,255,255,0.08)", my: 1.5, mx: 2 }} />

      {/* Admin */}
      <SectionLabel>{translate("padmakara.menu.administration")}</SectionLabel>
      <RaMenu.Item to="/users" primaryText={translate("resources.users.name", { smart_count: 2 })} leftIcon={<PeopleIcon />} />
      <RaMenu.Item to="/approvals" primaryText={translate("resources.approvals.name", { smart_count: 2 })} leftIcon={<HowToRegIcon />} />
      <RaMenu.Item to="/migrations" primaryText="Migrations" leftIcon={<SyncAltIcon />} />
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
      color: "rgba(255,255,255,0.35)",
      fontSize: "0.65rem",
      fontWeight: 600,
      letterSpacing: "0.1em",
    }}
  >
    {children}
  </Typography>
);
