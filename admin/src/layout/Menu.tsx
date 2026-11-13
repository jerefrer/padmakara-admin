import { Menu as RaMenu, useTranslate } from "react-admin";
import SpaIcon from "@mui/icons-material/SelfImprovement";
import GroupsIcon from "@mui/icons-material/Groups";
import PersonIcon from "@mui/icons-material/Person";
import PlaceIcon from "@mui/icons-material/Place";
import BusinessIcon from "@mui/icons-material/Business";
import PeopleIcon from "@mui/icons-material/People";
import CategoryIcon from "@mui/icons-material/Category";
import PeopleOutlineIcon from "@mui/icons-material/PeopleOutline";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import LibraryBooksIcon from "@mui/icons-material/LibraryBooks";
import SearchIcon from "@mui/icons-material/Search";
import BarChartIcon from "@mui/icons-material/BarChart";
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

      <SectionLabel>{translate("padmakara.menu.content")}</SectionLabel>
      <RaMenu.Item to="/events" primaryText={translate("resources.events.name", { smart_count: 2 })} leftIcon={<SpaIcon />} />
      <RaMenu.Item to="/publications" primaryText={translate("resources.publications.name", { smart_count: 2 })} leftIcon={<MenuBookIcon />} />

      <Divider sx={{ borderColor: "rgba(255,255,255,0.08)", my: 1.5, mx: 2 }} />

      <SectionLabel>{translate("padmakara.menu.users")}</SectionLabel>
      <RaMenu.Item to="/users" primaryText={translate("resources.users.name", { smart_count: 2 })} leftIcon={<PeopleIcon />} />

      <Divider sx={{ borderColor: "rgba(255,255,255,0.08)", my: 1.5, mx: 2 }} />

      <SectionLabel>{translate("padmakara.menu.app")}</SectionLabel>
      <RaMenu.Item to="/teachers" primaryText={translate("resources.teachers.name", { smart_count: 2 })} leftIcon={<PersonIcon />} />
      <RaMenu.Item to="/places" primaryText={translate("resources.places.name", { smart_count: 2 })} leftIcon={<PlaceIcon />} />
      <RaMenu.Item to="/organizers" primaryText={translate("resources.organizers.name", { smart_count: 2 })} leftIcon={<BusinessIcon />} />
      <RaMenu.Item to="/event-types" primaryText={translate("resources.event-types.name", { smart_count: 2 })} leftIcon={<CategoryIcon />} />
      <RaMenu.Item to="/groups" primaryText={translate("resources.groups.name", { smart_count: 2 })} leftIcon={<GroupsIcon />} />
      <RaMenu.Item to="/audiences" primaryText={translate("resources.audiences.name", { smart_count: 2 })} leftIcon={<PeopleOutlineIcon />} />

      <Divider sx={{ borderColor: "rgba(255,255,255,0.08)", my: 1.5, mx: 2 }} />

      <SectionLabel>{translate("padmakara.menu.other")}</SectionLabel>
      <RaMenu.Item to="/library" primaryText={translate("padmakara.library.menu")} leftIcon={<LibraryBooksIcon />} />
      <RaMenu.Item to="/searches" primaryText={translate("padmakara.searches.menu")} leftIcon={<SearchIcon />} />
      <RaMenu.Item to="/statistics" primaryText={translate("padmakara.statistics.menu")} leftIcon={<BarChartIcon />} />
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
