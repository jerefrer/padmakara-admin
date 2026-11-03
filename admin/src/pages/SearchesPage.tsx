import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import { Title, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";

interface StatRow { query: string; count: number; lastAt: string }
interface Stats { top: StatRow[]; noResults: StatRow[]; total: number }

const RANGES = [30, 90, 365, 730] as const;
type Range = (typeof RANGES)[number];

const StatsTable = ({ title, rows }: { title: string; rows: StatRow[] }) => {
  const translate = useTranslate();
  return (
    <Paper sx={{ p: 2, flex: 1, minWidth: 0, width: "100%" }}>
      <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>{title}</Typography>
      {rows.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {translate("padmakara.searches.empty")}
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{translate("padmakara.searches.query")}</TableCell>
              <TableCell align="right">{translate("padmakara.searches.count")}</TableCell>
              <TableCell>{translate("padmakara.searches.lastAt")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.query}>
                <TableCell sx={{ wordBreak: "break-word" }}>{r.query}</TableCell>
                <TableCell align="right">{r.count}</TableCell>
                <TableCell sx={{ whiteSpace: "nowrap" }}>
                  {r.lastAt ? new Date(r.lastAt).toLocaleDateString() : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Paper>
  );
};

/** Anonymous search statistics: what people look for and what finds nothing. */
export const SearchesPage = () => {
  const translate = useTranslate();
  const [days, setDays] = useState<Range>(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    authFetch(`/api/admin/search-queries/stats?days=${days}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Stats;
        if (!cancelled) setStats(json);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  return (
    <Box sx={{ maxWidth: 1100, mx: "auto", pt: 3 }}>
      <Title title={translate("padmakara.searches.pageTitle")} />
      <Typography variant="h6" sx={{ mb: 0.5 }}>{translate("padmakara.searches.pageTitle")}</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
        {translate("padmakara.searches.intro")}
      </Typography>

      <ToggleButtonGroup
        exclusive
        size="small"
        value={days}
        onChange={(_e, v: Range | null) => v && setDays(v)}
        sx={{ mb: 2 }}
      >
        {RANGES.map((r) => (
          <ToggleButton key={r} value={r}>{translate(`padmakara.searches.range${r}`)}</ToggleButton>
        ))}
      </ToggleButtonGroup>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{translate("padmakara.searches.loadFailed")}</Alert>}
      {stats && (
        <>
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            {translate("padmakara.searches.total", { count: stats.total })}
          </Typography>
          <Box sx={{ display: "flex", gap: 2, flexDirection: { xs: "column", md: "row" }, alignItems: "flex-start" }}>
            <StatsTable title={translate("padmakara.searches.mostSearched")} rows={stats.top} />
            <StatsTable title={translate("padmakara.searches.noResults")} rows={stats.noResults} />
          </Box>
        </>
      )}
    </Box>
  );
};
