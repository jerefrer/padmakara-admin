import { Fragment } from "react";
import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import CloseIcon from "@mui/icons-material/Close";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { formatEventDates } from "../../utils/eventDates";
import { Figure, formatDay } from "./format";
import { headCellSx, numberCellSx } from "./tableStyles";
import { useTeachingDetail } from "./useTeachingDetail";
import type { DateRange, EventRow, TeachingDetail } from "./types";

/** Wide enough for track titles on one line; the whole screen on a phone. */
export const DRAWER_WIDTH = "min(1100px, 92vw)";
const NUMBER_COLUMN_WIDTH = 112;

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface DetailRow {
  key: number;
  label: string;
  sub?: string;
  /** Consecutive rows with the same group share one header row above them. */
  group?: string;
  values: { value: number; decimals?: number }[];
}

/** One small table of the drawer: a label column and right-aligned counts, optionally grouped. */
const DetailTable = ({
  testId,
  heading,
  columns,
  rows,
  empty,
  locale,
}: {
  testId: string;
  heading: string;
  columns: string[];
  rows: DetailRow[];
  empty: string;
  locale: string;
}) => (
  <Box data-testid={testId} sx={{ mb: 3 }}>
    <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>{heading}</Typography>
    {rows.length === 0 ? (
      <Typography variant="body2" sx={{ color: "text.secondary" }}>{empty}</Typography>
    ) : (
      <Table size="small" stickyHeader sx={{ tableLayout: "fixed" }}>
        <TableHead>
          <TableRow>
            {columns.map((c, i) => (
              <TableCell
                key={c}
                sx={[
                  headCellSx,
                  i === 0
                    ? {}
                    : { ...numberCellSx, width: NUMBER_COLUMN_WIDTH, textTransform: "none", letterSpacing: 0 },
                ]}
              >
                {c}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r, i) => (
            <Fragment key={r.key}>
              {r.group !== undefined && r.group !== rows[i - 1]?.group && (
                <TableRow data-testid={`${testId}-group`}>
                  <TableCell
                    colSpan={columns.length}
                    sx={{ py: 0.75, bgcolor: "background.default", color: "text.secondary", fontWeight: 600, fontSize: "0.8125rem" }}
                  >
                    {r.group}
                  </TableCell>
                </TableRow>
              )}
              <TableRow
                data-testid={`${testId}-row`}
                // Explicit parity: group header rows would throw off nth-of-type zebra
                sx={{ "& > td": { bgcolor: i % 2 === 1 ? "grey.50" : "background.paper" } }}
              >
                <TableCell sx={{ py: 1, ...(r.group === undefined && { overflowWrap: "anywhere" }) }}>
                  <Typography
                    variant="body2"
                    noWrap={r.group !== undefined}
                    title={r.group !== undefined ? r.label : undefined}
                  >
                    {r.label}
                  </Typography>
                  {r.sub && (
                    <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>{r.sub}</Typography>
                  )}
                </TableCell>
                {r.values.map((v, j) => (
                  <TableCell key={j} sx={numberCellSx}>
                    <Figure value={v.value} locale={locale} decimals={v.decimals} />
                  </TableCell>
                ))}
              </TableRow>
            </Fragment>
          ))}
        </TableBody>
      </Table>
    )}
  </Box>
);

/** Plain words on how far back per-item counts go, or nothing when the whole period is covered. */
function recordingNote(data: TeachingDetail, locale: string, t: Translate): string | null {
  if (data.itemsRecordedFrom === null) return t("itemsNone");
  if (data.range.from < data.itemsRecordedFrom) return t("itemsFrom", { date: formatDay(data.itemsRecordedFrom, locale) });
  return null;
}

const DetailBody = ({ data, locale, t }: { data: TeachingDetail; locale: string; t: Translate }) => {
  const note = recordingNote(data, locale, t);
  const languageName = (code: string) => t(`language_${code}`);
  return (
    <>
      {note && (
        <Alert severity="info" data-testid="items-note" sx={{ mb: 2 }}>{note}</Alert>
      )}
      <DetailTable
        testId="detail-documents"
        heading={t("detailDocuments")}
        columns={[t("col_document"), t("col_opens")]}
        rows={data.documents.map((d) => ({
          key: d.id,
          label: d.title || d.filename,
          sub: d.title ? d.filename : undefined,
          values: [{ value: d.opens }],
        }))}
        empty={t("noDocuments")}
        locale={locale}
      />
      <DetailTable
        testId="detail-videos"
        heading={t("detailVideos")}
        columns={[t("col_video"), t("col_videoViewers"), t("col_videoStarts")]}
        rows={data.videos.map((v, i) => ({
          key: v.id,
          label: (locale === "pt" ? v.titlePt || v.title : v.title || v.titlePt) || t("videoPart", { n: i + 1 }),
          values: [{ value: v.viewers }, { value: v.plays }],
        }))}
        empty={t("noVideos")}
        locale={locale}
      />
      <DetailTable
        testId="detail-transcripts"
        heading={t("detailTranscripts")}
        columns={[t("col_file"), t("col_opens")]}
        rows={data.transcripts.map((tr) => ({
          key: tr.id,
          label: tr.filename || languageName(tr.language),
          sub: tr.filename ? languageName(tr.language) : undefined,
          values: [{ value: tr.opens }],
        }))}
        empty={t("noTranscripts")}
        locale={locale}
      />
      <DetailTable
        testId="detail-tracks"
        heading={t("detailTracks")}
        columns={[t("col_track"), t("col_listeners"), t("col_completedTracks"), t("col_listenHours")]}
        rows={data.tracks.map((tr) => ({
          key: tr.id,
          label: tr.title,
          group: [t("sessionNumber", { n: tr.sessionNumber }), tr.sessionTitle].filter(Boolean).join(" · "),
          values: [{ value: tr.listeners }, { value: tr.completions }, { value: tr.listenHours, decimals: 1 }],
        }))}
        empty={t("noListening")}
        locale={locale}
      />
    </>
  );
};

interface Props {
  /** The teaching whose detail is shown; null keeps the drawer closed. */
  event: EventRow | null;
  range: DateRange;
  locale: string;
  t: Translate;
  onClose: () => void;
  onOpenEvent: (id: number) => void;
}

/** Side panel with one teaching's per-document, per-video, per-transcript and per-track figures. */
export const TeachingDetailDrawer = ({ event, range, locale, t, onClose, onOpenEvent }: Props) => {
  const state = useTeachingDetail(event?.id ?? null, range);
  const title = event ? (locale === "pt" && event.titlePt ? event.titlePt : event.title) : "";

  return (
    <Drawer
      anchor="right"
      open={event !== null}
      onClose={onClose}
      // The theme styles drawers as the dark sidebar; this panel is ordinary page content
      slotProps={{
        paper: {
          sx: {
            width: "100%",
            "@media (min-width:700px)": { width: DRAWER_WIDTH },
            bgcolor: "background.paper",
            color: "text.primary",
          },
        },
      }}
    >
      {event && (
        <Box data-testid="teaching-drawer" sx={{ p: 3 }}>
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, mb: 0.5 }}>
            <Typography variant="h6" component="h2" sx={{ flex: 1, lineHeight: 1.3 }}>{title}</Typography>
            <IconButton aria-label={t("close")} onClick={onClose} size="small" sx={{ mt: -0.5 }}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>
          <Typography variant="body2" sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
            {formatEventDates(event.startDate, event.endDate)}
          </Typography>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
            {t("detailPeriod", { period: formatEventDates(range.from, range.to) })}
          </Typography>
          <Button
            size="small"
            variant="outlined"
            startIcon={<OpenInNewIcon fontSize="small" />}
            onClick={() => onOpenEvent(event.id)}
            data-testid="open-event"
            sx={{ mb: 3 }}
          >
            {t("openEvent")}
          </Button>

          {state.status === "loading" && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={28} />
            </Box>
          )}
          {state.status === "error" && <Alert severity="error">{t("detailLoadFailed")}</Alert>}
          {state.status === "ready" && <DetailBody data={state.data} locale={locale} t={t} />}
        </Box>
      )}
    </Drawer>
  );
};
