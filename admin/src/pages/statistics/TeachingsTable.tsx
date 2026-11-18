import { useMemo, useState, type KeyboardEvent } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import InputAdornment from "@mui/material/InputAdornment";
import Tooltip from "@mui/material/Tooltip";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TableSortLabel from "@mui/material/TableSortLabel";
import SearchIcon from "@mui/icons-material/Search";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import type { Theme } from "@mui/material/styles";
import type { SystemStyleObject } from "@mui/system";
import { formatEventDates } from "../../utils/eventDates";
import { Figure, searchable } from "./format";
import { headCellSx, numberCellSx, totalCellSx, zebraRowSx } from "./tableStyles";
import type { EventRow } from "./types";

type NumberKey =
  | "listeners" | "completedTracks" | "listenHours" | "videoViewers" | "videoStarts"
  | "transcriptOpens" | "readAlongOpens" | "fileOpens" | "downloads";
type SortKey = NumberKey | "title";
type Group = "audio" | "video" | "texts" | "downloads";

interface Column {
  key: NumberKey;
  group: Group;
  decimals?: number;
  /** People, not events: one person can be in several teachings, so no total. */
  notAdditive?: boolean;
}

const COLUMNS: Column[] = [
  { key: "listeners", group: "audio", notAdditive: true },
  { key: "completedTracks", group: "audio" },
  { key: "listenHours", group: "audio", decimals: 1 },
  { key: "videoViewers", group: "video", notAdditive: true },
  { key: "videoStarts", group: "video" },
  { key: "transcriptOpens", group: "texts" },
  { key: "readAlongOpens", group: "texts" },
  { key: "fileOpens", group: "texts" },
  { key: "downloads", group: "downloads" },
];

/** Groups that get a two-level header; Downloads is a single column spanning both rows. */
const GROUPS: { group: Exclude<Group, "downloads">; span: number }[] = [
  { group: "audio", span: 3 },
  { group: "video", span: 2 },
  { group: "texts", span: 3 },
];

/** Height of the group header row, so the column header row can stick right under it. */
const GROUP_ROW_HEIGHT = 34;

/** Real downloads only: event ZIPs and offline video downloads. Video plays and opened documents have their own columns. */
const valueOf = (e: EventRow, key: NumberKey): number =>
  key === "downloads" ? e.zipDownloads + e.videoDownloads : e[key];

/** The Portuguese title in Portuguese when there is one, the English one otherwise. */
const titleIn = (e: EventRow, locale: string): string => (locale === "pt" && e.titlePt ? e.titlePt : e.title);

/** First column of each group carries a faint rule, so the groups read as blocks. */
const startsGroup = (i: number): boolean => i === 0 || COLUMNS[i - 1]!.group !== COLUMNS[i]!.group;
const groupRule = (theme: Theme): string => `1px solid ${theme.palette.divider}`;

const stickyFirstColumn = (theme: Theme): SystemStyleObject<Theme> => ({
  position: "sticky",
  left: 0,
  zIndex: 1,
  borderRight: groupRule(theme),
});

interface Props {
  events: EventRow[];
  locale: string;
  t: (key: string, options?: Record<string, unknown>) => string;
  onOpen: (event: EventRow) => void;
}

/** The per-teaching table: grouped columns, sortable, searchable, with a totals row. */
export const TeachingsTable = ({ events, locale, t, onOpen }: Props) => {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "listeners", dir: "desc" });
  const [query, setQuery] = useState("");

  const titleOf = (e: EventRow): string => titleIn(e, locale);

  const rows = useMemo(() => {
    const needle = searchable(query.trim());
    const filtered = needle
      ? events.filter((e) => searchable(`${e.title} ${e.titlePt ?? ""}`).includes(needle))
      : events;
    const sign = sort.dir === "desc" ? -1 : 1;
    return [...filtered].sort((a, b) => {
      if (sort.key === "title") return sign * titleIn(a, locale).localeCompare(titleIn(b, locale), locale);
      return sign * (valueOf(a, sort.key) - valueOf(b, sort.key));
    });
  }, [events, query, sort, locale]);

  const totals = useMemo(() => {
    const out = {} as Record<NumberKey, number>;
    for (const c of COLUMNS) {
      const sum = rows.reduce((acc, e) => acc + valueOf(e, c.key), 0);
      out[c.key] = c.decimals ? Math.round(sum * 10) / 10 : sum;
    }
    return out;
  }, [rows]);

  const onSort = (key: SortKey) =>
    setSort((s) => {
      if (s.key === key) return { key, dir: s.dir === "desc" ? "asc" : "desc" };
      return { key, dir: key === "title" ? "asc" : "desc" };
    });

  const onRowKey = (e: KeyboardEvent, row: EventRow) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(row);
    }
  };

  const sortLabel = (key: SortKey, label: string, help?: string) => {
    const active = sort.key === key;
    return (
      <TableSortLabel
        data-testid={`sort-${key}`}
        active={active}
        direction={active ? sort.dir : key === "title" ? "asc" : "desc"}
        onClick={() => onSort(key)}
        sx={{ "& .MuiTableSortLabel-icon": { display: active ? undefined : "none" } }}
      >
        {help ? (
          <Tooltip title={help} enterDelay={300} arrow>
            <Box
              component="span"
              data-testid={`help-${key}`}
              sx={{ textDecoration: "underline dotted", textUnderlineOffset: "3px", textDecorationColor: "currentColor" }}
            >
              {label}
            </Box>
          </Tooltip>
        ) : (
          label
        )}
      </TableSortLabel>
    );
  };

  return (
    <Paper sx={{ mb: 2, overflow: "hidden" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap", px: 2, pt: 2, pb: 1.5 }}>
        <Box sx={{ flex: "1 1 240px", minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{t("teachings")}</Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>{t("teachingsNote")}</Typography>
        </Box>
        <TextField
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          inputProps={{ "aria-label": t("searchPlaceholder"), "data-testid": "teaching-search" }}
          sx={{ flex: "0 1 280px", minWidth: 200 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" sx={{ color: "text.secondary" }} />
              </InputAdornment>
            ),
          }}
        />
      </Box>

      <TableContainer sx={{ maxHeight: "min(72vh, 820px)" }}>
        <Table size="small" sx={{ borderCollapse: "separate", borderSpacing: 0 }}>
          {/* The theme styles header cells through TableHead ("& .MuiTableCell-head"), which per-cell sx cannot
              outrank, so this table's header layout is set at the same level. */}
          <TableHead
            sx={(th) => ({
              "& .MuiTableCell-head": {
                ...headCellSx,
                position: "sticky",
                top: 0,
                zIndex: 2,
                whiteSpace: "nowrap",
                px: 1.25,
                py: 1,
              },
              "& .MuiTableCell-head.stats-first": {
                ...stickyFirstColumn(th),
                top: 0,
                zIndex: 3,
                px: 2,
                minWidth: 220,
                verticalAlign: "bottom",
              },
              "& .MuiTableCell-head.stats-group": {
                height: GROUP_ROW_HEIGHT,
                boxSizing: "border-box",
                py: 0.5,
                // The theme's thick header rule belongs under the whole header, not between its two rows
                borderBottom: groupRule(th),
              },
              "& .MuiTableCell-head.stats-column": {
                textTransform: "none",
                letterSpacing: 0,
                fontSize: "0.8rem",
                verticalAlign: "bottom",
              },
              "& .MuiTableCell-head.stats-second-row": { top: GROUP_ROW_HEIGHT },
              "& .MuiTableCell-head.stats-group-start": { borderLeft: groupRule(th) },
            })}
          >
            <TableRow>
              <TableCell rowSpan={2} className="stats-first" sortDirection={sort.key === "title" ? sort.dir : false}>
                {sortLabel("title", t("teaching"))}
              </TableCell>
              {GROUPS.map(({ group, span }) => (
                <TableCell key={group} colSpan={span} align="center" className="stats-group stats-group-start">
                  {t(`group_${group}`)}
                </TableCell>
              ))}
              <TableCell
                rowSpan={2}
                align="right"
                className="stats-column stats-group-start"
                sortDirection={sort.key === "downloads" ? sort.dir : false}
              >
                {sortLabel("downloads", t("col_downloads"), t("help_downloads"))}
              </TableCell>
            </TableRow>
            <TableRow>
              {COLUMNS.filter((c) => c.group !== "downloads").map((c) => (
                <TableCell
                  key={c.key}
                  align="right"
                  className={`stats-column stats-second-row${startsGroup(COLUMNS.indexOf(c)) ? " stats-group-start" : ""}`}
                  sortDirection={sort.key === c.key ? sort.dir : false}
                >
                  {sortLabel(c.key, t(`col_${c.key}`), t(`help_${c.key}`))}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={COLUMNS.length + 1} sx={{ color: "text.secondary", py: 3, textAlign: "center" }}>
                  {t("noMatch", { query: query.trim() })}
                </TableCell>
              </TableRow>
            )}
            {rows.map((e) => {
              const title = titleOf(e);
              return (
                <TableRow
                  key={e.id}
                  data-testid="event-row"
                  tabIndex={0}
                  aria-label={`${title}, ${t("openDetails")}`}
                  onClick={() => onOpen(e)}
                  onKeyDown={(ev) => onRowKey(ev, e)}
                  sx={zebraRowSx(true)}
                >
                  <TableCell sx={(th) => ({ ...stickyFirstColumn(th), py: 1, maxWidth: 340 })}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Tooltip title={title} enterDelay={500} placement="top-start">
                          <Typography
                            variant="body2"
                            data-testid="event-title"
                            sx={{
                              fontWeight: 500,
                              lineHeight: 1.35,
                              display: "-webkit-box",
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: "vertical",
                              overflow: "hidden",
                            }}
                          >
                            {title}
                          </Typography>
                        </Tooltip>
                        <Typography
                          variant="caption"
                          data-testid="event-dates"
                          sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}
                        >
                          {formatEventDates(e.startDate, e.endDate)}
                        </Typography>
                      </Box>
                      <ChevronRightIcon fontSize="small" sx={{ color: "text.disabled", flexShrink: 0 }} />
                    </Box>
                  </TableCell>
                  {COLUMNS.map((c, i) => (
                    <TableCell
                      key={c.key}
                      sx={(th) => ({ ...numberCellSx, borderLeft: startsGroup(i) ? groupRule(th) : undefined })}
                    >
                      <Figure value={valueOf(e, c.key)} locale={locale} decimals={c.decimals} />
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
            {rows.length > 0 && (
              <TableRow data-testid="total-row">
                <TableCell sx={(th) => ({ ...totalCellSx(th), ...stickyFirstColumn(th), bottom: 0, zIndex: 2 })}>
                  {t("totalOf", { smart_count: rows.length })}
                </TableCell>
                {COLUMNS.map((c, i) => (
                  <TableCell
                    key={c.key}
                    sx={(th) => ({
                      ...numberCellSx,
                      ...totalCellSx(th),
                      position: "sticky",
                      bottom: 0,
                      zIndex: 1,
                      borderLeft: startsGroup(i) ? groupRule(th) : undefined,
                    })}
                  >
                    {c.notAdditive ? "" : <Figure value={totals[c.key]} locale={locale} decimals={c.decimals} />}
                  </TableCell>
                ))}
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
};
