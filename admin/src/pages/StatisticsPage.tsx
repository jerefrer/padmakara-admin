import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { Title, useLocaleState, useTranslate } from "react-admin";
import { authFetch } from "../utils/authFetch";
import { rangeFor, STATISTICS_RANGES, type StatisticsRange } from "../utils/statisticsRange";
import { TeachingsTable } from "./statistics/TeachingsTable";
import { TeachingDetailDrawer } from "./statistics/TeachingDetailDrawer";
import type { EventRow } from "./statistics/types";

interface MonthRow {
  month: string;
  signups: number;
  activeUsers: number;
  teachingSalesCents: number;
  membershipCents: number;
  readAlongOpens: number;
}
interface Stats {
  accounts: { total: number; newInRange: number; activeMembers: number };
  activeUsers: { last7: number; last30: number; inRange: number };
  monthly: MonthRow[];
  platforms: { deviceType: string; count: number }[];
  events: EventRow[];
}

const PLATFORM_LABELS: Record<string, string> = { ios: "iPhone", android: "Android", web: "Web" };

const euros = (cents: number): string => {
  const v = cents / 100;
  return `€${Number.isInteger(v) ? v : v.toFixed(2)}`;
};

const Tile = ({ label, value }: { label: string; value: number }) => (
  <Paper sx={{ p: 2, flex: "1 1 160px", minWidth: 0 }}>
    <Typography variant="h5" sx={{ fontWeight: 600 }}>{value}</Typography>
    <Typography variant="body2" sx={{ color: "text.secondary" }}>{label}</Typography>
  </Paper>
);

/** Simple vertical bars built from boxes (the admin has no chart library). */
const MonthBars = ({
  title,
  rows,
  format = String,
}: {
  title: string;
  rows: { label: string; value: number }[];
  format?: (v: number) => string;
}) => {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Paper sx={{ p: 2, minWidth: 0 }}>
      <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>{title}</Typography>
      <Box sx={{ display: "flex", alignItems: "flex-end", gap: 0.5, height: 120 }}>
        {rows.map((r) => (
          <Box
            key={r.label}
            title={`${r.label}: ${format(r.value)}`}
            sx={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", height: "100%" }}
          >
            <Typography variant="caption" sx={{ fontSize: "0.6rem", lineHeight: 1 }}>
              {r.value > 0 ? format(r.value) : ""}
            </Typography>
            <Box sx={{ width: "100%", height: `${(r.value / max) * 80}%`, minHeight: r.value > 0 ? 2 : 0, bgcolor: "primary.main", borderRadius: "2px 2px 0 0" }} />
          </Box>
        ))}
      </Box>
      <Box sx={{ display: "flex", gap: 0.5, mt: 0.5 }}>
        {rows.map((r) => (
          <Typography key={r.label} variant="caption" sx={{ flex: 1, textAlign: "center", fontSize: "0.6rem", color: "text.secondary" }}>
            {r.label.slice(5)}
          </Typography>
        ))}
      </Box>
    </Paper>
  );
};

const PlatformBars = ({ rows }: { rows: { deviceType: string; count: number }[] }) => {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Box>
      {rows.map((r) => (
        <Box key={r.deviceType} sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 0.75 }}>
          <Typography variant="body2" sx={{ width: 80 }}>{PLATFORM_LABELS[r.deviceType] ?? r.deviceType}</Typography>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ width: `${(r.count / max) * 100}%`, height: 14, bgcolor: "primary.main", borderRadius: 0.5 }} />
          </Box>
          <Typography variant="body2" sx={{ width: 40, textAlign: "right" }}>{r.count}</Typography>
        </Box>
      ))}
    </Box>
  );
};

/** Aggregate usage statistics: totals only, counted on the server. */
export const StatisticsPage = () => {
  const translate = useTranslate();
  const [locale] = useLocaleState();
  const navigate = useNavigate();
  const [days, setDays] = useState<StatisticsRange>(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<EventRow | null>(null);
  const range = useMemo(() => rangeFor(days), [days]);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    const { from, to } = range;
    authFetch(`/api/admin/statistics?from=${from}&to=${to}`)
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
  }, [range]);

  const t = (key: string, options?: Record<string, unknown>) => translate(`padmakara.statistics.${key}`, options);
  const monthRows = (pick: (m: MonthRow) => number) =>
    (stats?.monthly ?? []).map((m) => ({ label: m.month, value: pick(m) }));

  return (
    <Box sx={{ maxWidth: 1280, mx: "auto", pt: 3 }}>
      <Title title={t("pageTitle")} />
      <Typography variant="h6" sx={{ mb: 0.5 }}>{t("pageTitle")}</Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>{t("intro")}</Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{t("loadFailed")}</Alert>}
      {stats && (
        <>
          <Typography variant="subtitle2" sx={{ mb: 1, color: "text.secondary", textTransform: "uppercase" }}>{t("last12Heading")}</Typography>
          <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", mb: 2 }}>
            <Tile label={t("accounts")} value={stats.accounts.total} />
            <Tile label={t("activeMembers")} value={stats.accounts.activeMembers} />
            <Tile label={t("active7")} value={stats.activeUsers.last7} />
            <Tile label={t("active30")} value={stats.activeUsers.last30} />
          </Box>

          <Box
            data-testid="chart-grid"
            sx={{ display: "grid", gap: 2, mb: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}
          >
            <MonthBars title={`${t("signups")}, ${t("last12")}`} rows={monthRows((m) => m.signups)} />
            <MonthBars title={`${t("activeUsersMonthly")}, ${t("last12")}`} rows={monthRows((m) => m.activeUsers)} />
            <MonthBars title={`${t("teachingSales")}, ${t("last12")}`} rows={monthRows((m) => m.teachingSalesCents)} format={euros} />
            <MonthBars title={`${t("membershipIncome")}, ${t("last12")}`} rows={monthRows((m) => m.membershipCents)} format={euros} />
          </Box>

        <ToggleButtonGroup
          exclusive
          size="small"
          value={days}
          onChange={(_e, v: StatisticsRange | null) => v && setDays(v)}
          sx={{ mb: 2 }}
        >
          {STATISTICS_RANGES.map((r) => (
            <ToggleButton key={r} value={r} data-testid={`range-${r}`}>{t(`range${r}`)}</ToggleButton>
          ))}
        </ToggleButtonGroup>

          <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", mb: 2 }}>
            <Tile label={t("newAccounts")} value={stats.accounts.newInRange} />
          </Box>

          <Paper sx={{ p: 2, mb: 2 }}>
            <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>{t("platforms")}</Typography>
            {stats.platforms.length === 0 ? (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>{t("empty")}</Typography>
            ) : (
              <PlatformBars rows={stats.platforms} />
            )}
          </Paper>

          {stats.events.length === 0 ? (
            <Paper sx={{ p: 2, mb: 2 }}>
              <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>{t("teachings")}</Typography>
              <Typography variant="body2" sx={{ color: "text.secondary" }}>{t("empty")}</Typography>
            </Paper>
          ) : (
            <TeachingsTable events={stats.events} locale={locale} t={t} onOpen={setSelected} />
          )}
          <TeachingDetailDrawer
            event={selected}
            range={range}
            locale={locale}
            t={t}
            onClose={() => setSelected(null)}
            onOpenEvent={(id) => navigate(`/events/${id}`)}
          />

          <Typography variant="caption" sx={{ color: "text.secondary", display: "block", mb: 3 }}>
            {t("privacyNote")}
          </Typography>
        </>
      )}
    </Box>
  );
};
