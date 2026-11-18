import Box from "@mui/material/Box";

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, decimals: number): Intl.NumberFormat {
  const key = `${locale}:${decimals}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale === "pt" ? "pt-PT" : "en-GB", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    numberFormats.set(key, f);
  }
  return f;
}

/** A count with thousands separators, or hours with one decimal. Zero is always a plain "0". */
export function formatCount(value: number, locale: string, decimals = 0): string {
  if (value === 0) return "0";
  return numberFormat(locale, decimals).format(value);
}

/**
 * A right-aligned figure: tabular digits so columns line up, and a muted zero
 * so the counts that matter stand out.
 */
export const Figure = ({ value, locale, decimals = 0 }: { value: number; locale: string; decimals?: number }) => (
  <Box
    component="span"
    data-zero={value === 0 ? "true" : undefined}
    sx={{ fontVariantNumeric: "tabular-nums", color: value === 0 ? "text.disabled" : "inherit" }}
  >
    {formatCount(value, locale, decimals)}
  </Box>
);

/** "19 Nov 2026" / "19 nov. 2026" for a YYYY-MM-DD day, read as written. */
export function formatDay(day: string, locale: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(locale === "pt" ? "pt-PT" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** Lower-case, accent-free text for forgiving title search ("ngondro" finds "Ngöndro"). */
export function searchable(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
