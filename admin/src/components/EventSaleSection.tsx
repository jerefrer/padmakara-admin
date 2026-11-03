/**
 * "Access & sale" card of the event page: how the event is offered on its own
 * (not at all, free, or for a price), the shareable link, and the sale stats.
 * Prices are euros in the UI and cents in the API.
 */

import { useEffect, useState } from "react";
import { useNotify, useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputAdornment from "@mui/material/InputAdornment";
import Paper from "@mui/material/Paper";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import SellIcon from "@mui/icons-material/Sell";
import type { SaleStats } from "./useEventAccess";

export type SaleMode = "none" | "free" | "paid";

export interface SaleValue {
  saleMode: SaleMode;
  priceCents: number | null;
  includedInMembership: boolean;
}

interface Props {
  value: SaleValue;
  onChange: (patch: Partial<SaleValue>) => void;
  /** Set once the event exists: the link and stats need it. */
  eventId?: number;
  stats?: SaleStats | null;
}

export const DEFAULT_PRICE_CENTS = 1500;
export const MIN_PRICE_CENTS = 100;
export const teachingLink = (eventId: number): string => `https://app.padmakara.pt/get/${eventId}`;

export const formatEuros = (cents: number): string => `€${(cents / 100).toFixed(2)}`;

/** "12,50" / "12.5" / "12" → 1250 / 1250 / 1200; null when not a valid amount. */
export function eurosToCents(text: string): number | null {
  const normalised = text.trim().replace(",", ".");
  if (!/^\d+(\.\d{0,2})?$/.test(normalised)) return null;
  return Math.round(parseFloat(normalised) * 100);
}

const centsToText = (cents: number | null): string => (cents == null ? "" : (cents / 100).toFixed(2));

export const EventSaleSection = ({ value, onChange, eventId, stats }: Props) => {
  const translate = useTranslate();
  const notify = useNotify();
  const [priceText, setPriceText] = useState(centsToText(value.priceCents));

  // Follow outside changes (the event loading, the Paid prefill) without
  // fighting the admin's typing: only overwrite when the text means something else.
  useEffect(() => {
    setPriceText((text) => (eurosToCents(text) === value.priceCents ? text : centsToText(value.priceCents)));
  }, [value.priceCents]);

  const handleMode = (mode: SaleMode) => {
    if (mode === "paid" && value.priceCents == null) {
      onChange({ saleMode: mode, priceCents: DEFAULT_PRICE_CENTS });
    } else {
      onChange({ saleMode: mode });
    }
  };

  const handlePrice = (text: string) => {
    setPriceText(text);
    onChange({ priceCents: eurosToCents(text) });
  };

  const handleCopy = async () => {
    if (eventId === undefined) return;
    try {
      await navigator.clipboard.writeText(teachingLink(eventId));
      notify(translate("padmakara.eventSale.copied") || "Link copied", { type: "success" });
    } catch {
      notify(translate("padmakara.eventSale.copyFailed") || "Could not copy the link", { type: "warning" });
    }
  };

  const priceInvalid = value.saleMode === "paid" && (value.priceCents ?? 0) < MIN_PRICE_CENTS;

  return (
    <Paper sx={{ p: 3, mb: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
        <SellIcon sx={{ color: "primary.main" }} />
        <Typography variant="h6" sx={{ lineHeight: 1.3 }}>
          {translate("padmakara.eventSale.title")}
        </Typography>
      </Box>
      <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
        {translate("padmakara.eventSale.subtitle")}
      </Typography>

      <RadioGroup row value={value.saleMode} onChange={(_, v) => handleMode(v as SaleMode)}>
        <FormControlLabel value="none" control={<Radio />} label={translate("padmakara.eventSale.none")} />
        <FormControlLabel value="free" control={<Radio />} label={translate("padmakara.eventSale.free")} />
        <FormControlLabel value="paid" control={<Radio />} label={translate("padmakara.eventSale.paid")} />
      </RadioGroup>

      {value.saleMode === "paid" && (
        <TextField
          label={translate("padmakara.eventSale.price")}
          value={priceText}
          onChange={(e) => handlePrice(e.target.value)}
          error={priceInvalid}
          helperText={priceInvalid ? translate("padmakara.eventSale.priceMin") : undefined}
          size="small"
          sx={{ mt: 1, width: 180 }}
          slotProps={{
            htmlInput: { inputMode: "decimal" },
            input: { startAdornment: <InputAdornment position="start">€</InputAdornment> },
          }}
        />
      )}

      <Box sx={{ mt: 1 }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={value.includedInMembership}
              onChange={(_, checked) => onChange({ includedInMembership: checked })}
            />
          }
          label={translate("padmakara.eventSale.includedInMembership")}
        />
        <Typography variant="caption" sx={{ display: "block", color: "text.secondary", ml: 4 }}>
          {translate("padmakara.eventSale.includedHint")}
        </Typography>
      </Box>

      {eventId !== undefined && value.saleMode !== "none" && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="caption" sx={{ fontWeight: 600, color: "text.secondary" }}>
            {translate("padmakara.eventSale.link")}
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            <Typography variant="body2" sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>
              {teachingLink(eventId)}
            </Typography>
            <Button size="small" startIcon={<ContentCopyIcon />} onClick={handleCopy}>
              {translate("padmakara.eventSale.copy")}
            </Button>
          </Box>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {translate("padmakara.eventSale.linkHint")}
          </Typography>
        </Box>
      )}

      {eventId !== undefined && stats && (
        <Box sx={{ display: "flex", gap: 4, flexWrap: "wrap", mt: 2 }}>
          <Stat label={translate("padmakara.eventSale.statSold")} value={String(stats.paidCount)} />
          <Stat label={translate("padmakara.eventSale.statCollected")} value={formatEuros(stats.collectedCents)} />
          <Stat label={translate("padmakara.eventSale.statPending")} value={String(stats.pendingCount)} />
        </Box>
      )}
    </Paper>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <Box>
    <Typography variant="h6" sx={{ lineHeight: 1.2 }}>{value}</Typography>
    <Typography variant="caption" sx={{ color: "text.secondary" }}>{label}</Typography>
  </Box>
);
