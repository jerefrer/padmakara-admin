/**
 * "Who can access this event" chooser: one audience, picked from a grouped list
 * of radio rows (free for…, paid, given by hand only), and on the right only the
 * controls that choice needs ("others can buy it", price, the shareable link and
 * the sale stats). The retreat groups themselves are set in Event details.
 *
 * The rows are the Audiences list, with its names and order. The rule each row
 * follows is matched by slug, never by id: an audience created in the admin has
 * no rule of its own, so it is given by hand. What is saved:
 *  - free / by-hand options on their own: saleMode "none", no price;
 *  - "others can buy it" or a paid option: saleMode "paid" with the price;
 *  - includedInMembership is no longer set here (the "Every member" option says it).
 * Prices are euros in the UI and cents in the API.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useNotify, useTranslate } from "react-admin";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputAdornment from "@mui/material/InputAdornment";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import type { SaleStats } from "./useEventAccess";

export type SaleMode = "none" | "free" | "paid";

export interface SaleValue {
  saleMode: SaleMode;
  priceCents: number | null;
  includedInMembership: boolean;
}

export interface AudienceChoice {
  id: number;
  nameEn: string;
  namePt: string | null;
  slug: string;
}

export interface GroupChoice {
  id: number;
  nameEn: string;
  namePt: string | null;
  abbreviation: string | null;
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

type OptionGroup = "free" | "paid" | "hand";

interface AccessOption {
  slug: string;
  /** i18n key under padmakara.eventAccessChooser.options (description and panel text). */
  key: string;
  group: OptionGroup;
  /** The paid options are always sold; the others can be sold on the side. */
  paid?: boolean;
  /** "Others can buy it" is offered. */
  canSell?: boolean;
  /** Opened by the event's retreat groups. */
  groups?: boolean;
}

export const ACCESS_OPTIONS: readonly AccessOption[] = [
  { slug: "free-anyone", key: "everyone", group: "free" },
  { slug: "free-subscribers", key: "members", group: "free", canSell: true },
  { slug: "account-holders", key: "accountHolders", group: "free", canSell: true },
  { slug: "retreat-group-members", key: "groups", group: "free", canSell: true, groups: true },
  { slug: "retreat-group-members-no-membership", key: "groupsNoMembership", group: "free", canSell: true, groups: true },
  { slug: "event-participants", key: "participants", group: "free", canSell: true },
  { slug: "event-participants-no-membership", key: "participantsNoMembership", group: "free", canSell: true },
  { slug: "everyone-paid", key: "everyonePaid", group: "paid", paid: true },
  { slug: "member-extra-subscription", key: "membersPaid", group: "paid", paid: true },
  { slug: "received-initiation", key: "initiation", group: "hand" },
  { slug: "available-on-request-only", key: "onRequest", group: "hand" },
  { slug: "restricted", key: "restricted", group: "hand" },
];

/**
 * Audiences that differ only by whether an active membership is required. They share
 * one row in the list; a switch on the right panel moves between the two slugs.
 */
export interface MembershipPair {
  /** i18n key under padmakara.eventAccessChooser.pairs. */
  key: string;
  required: string;
  optional: string;
}

export const MEMBERSHIP_PAIRS: readonly MembershipPair[] = [
  { key: "accounts", required: "free-subscribers", optional: "account-holders" },
  { key: "groups", required: "retreat-group-members", optional: "retreat-group-members-no-membership" },
  { key: "participants", required: "event-participants", optional: "event-participants-no-membership" },
];

const pairForSlug = (slug: string | null | undefined): MembershipPair | undefined =>
  MEMBERSHIP_PAIRS.find((p) => p.required === slug || p.optional === slug);

/** The groups of a parallel retreat: both variants of the user-groups audience. */
const isGroupsSlug = (slug: string): boolean => pairForSlug(slug)?.key === "groups";

const GROUP_ORDER: readonly OptionGroup[] = ["free", "paid", "hand"];
const GROUP_LABEL_KEY: Record<OptionGroup, string> = {
  free: "groupFree",
  paid: "groupPaid",
  hand: "groupHand",
};

export const optionForSlug = (slug: string | null | undefined): AccessOption | undefined =>
  ACCESS_OPTIONS.find((o) => o.slug === slug);

/** The rule an audience follows; one created in the admin is given by hand. */
export const optionForAudience = (audience: Pick<AudienceChoice, "slug">): AccessOption =>
  optionForSlug(audience.slug) ?? { slug: audience.slug, key: "custom", group: "hand" };

const localised = (o: { nameEn: string; namePt: string | null }, locale: string): string =>
  locale === "pt" && o.namePt ? o.namePt : o.nameEn;

/** Sale fields to save when the admin picks `next` while `previous` was chosen. */
export function saleForChoice(next: AccessOption, previous: AccessOption | undefined, sale: SaleValue): SaleValue {
  if (next.paid) {
    return { saleMode: "paid", priceCents: sale.priceCents ?? DEFAULT_PRICE_CENTS, includedInMembership: false };
  }
  // Moving between "free for…" options keeps an existing "others can buy it".
  if (next.canSell && !previous?.paid) return { ...sale, includedInMembership: false };
  return { saleMode: "none", priceCents: null, includedInMembership: false };
}

interface SummaryInput {
  audience: AudienceChoice | null;
  sale: SaleValue;
  stats?: SaleStats | null;
  locale: string;
  translate: (key: string, options?: Record<string, unknown>) => string;
}

/** One line for the card header: the option, the price and sales. Event details names the groups. */
export function accessSummary({ audience, sale, stats, locale, translate }: SummaryInput): string {
  if (!audience) return translate("padmakara.eventAccessChooser.notSet");
  const parts = [localised(audience, locale)];
  if (sale.saleMode === "paid" && sale.priceCents != null) {
    parts.push(formatEuros(sale.priceCents));
    if (stats && stats.paidCount > 0) {
      parts.push(translate("padmakara.eventAccessChooser.soldCount", { count: stats.paidCount }));
    }
  }
  return parts.join(" · ");
}

interface Props<A extends AudienceChoice> {
  audiences: A[];
  selectedAudience: A | null;
  onAudienceChange: (audience: A | null) => void;
  sale: SaleValue;
  onSaleChange: (patch: Partial<SaleValue>) => void;
  /** Parallel retreats are always for the members of their retreat groups. */
  frozen?: boolean;
  locale: string;
  /** Set once the event exists: the link and stats need it. */
  eventId?: number;
  stats?: SaleStats | null;
}

export function EventAccessChooser<A extends AudienceChoice>({
  audiences,
  selectedAudience,
  onAudienceChange,
  sale,
  onSaleChange,
  frozen,
  locale,
  eventId,
  stats,
}: Props<A>) {
  const translate = useTranslate();
  const notify = useNotify();
  const t = (key: string, options?: Record<string, unknown>) =>
    translate(`padmakara.eventAccessChooser.${key}`, options);
  const [priceText, setPriceText] = useState(centsToText(sale.priceCents));

  // Follow outside changes (the event loading, a paid option's prefill) without
  // fighting the admin's typing: only overwrite when the text means something else.
  useEffect(() => {
    setPriceText((text) => (eurosToCents(text) === sale.priceCents ? text : centsToText(sale.priceCents)));
  }, [sale.priceCents]);

  const current = selectedAudience ? optionForAudience(selectedAudience) : undefined;

  const handleChoose = (audience: A) => {
    const option = optionForAudience(audience);
    onAudienceChange(audience);
    const next = saleForChoice(option, current, sale);
    if (next.saleMode !== sale.saleMode || next.priceCents !== sale.priceCents || next.includedInMembership !== sale.includedInMembership) {
      onSaleChange(next);
    }
  };

  const handleOthersCanBuy = (on: boolean) => {
    onSaleChange(
      on
        ? { saleMode: "paid", priceCents: sale.priceCents ?? DEFAULT_PRICE_CENTS }
        : { saleMode: "none", priceCents: null },
    );
  };

  const handlePrice = (text: string) => {
    setPriceText(text);
    onSaleChange({ priceCents: eurosToCents(text) });
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

  // The membership switch needs both variants of the pair to exist in the Audiences list.
  const selectedPair = pairForSlug(selectedAudience?.slug);
  const requiredVariant = selectedPair && audiences.find((a) => a.slug === selectedPair.required);
  const optionalVariant = selectedPair && audiences.find((a) => a.slug === selectedPair.optional);
  const showMembershipSwitch = !!selectedPair && !!requiredVariant && !!optionalVariant;
  const requiresMembership = selectedAudience?.slug === selectedPair?.required;

  const handleRequiresMembership = (on: boolean) => {
    const target = on ? requiredVariant : optionalVariant;
    if (target) handleChoose(target);
  };

  const othersCanBuy = !!current?.canSell && sale.saleMode === "paid";
  const showPrice = !!current?.paid || othersCanBuy;
  const priceInvalid = showPrice && (sale.priceCents ?? 0) < MIN_PRICE_CENTS;
  const sold = sale.saleMode !== "none";
  const showStats = !!stats && (sold || stats.paidCount > 0 || stats.pendingCount > 0);

  const renderRow = (audience: A): ReactNode => {
    const option = optionForAudience(audience);
    const pair = pairForSlug(audience.slug);
    // A pair is one row. It stands at the required audience (or at the optional one
    // when that is all the Audiences list has) and shows whichever variant is picked.
    const pairMembers = pair ? audiences.filter((a) => a.slug === pair.required || a.slug === pair.optional) : [];
    if (pair && audience.slug === pair.optional && pairMembers.some((a) => a.slug === pair.required)) return null;
    const selectedInPair = pair && pairMembers.find((a) => a.slug === selectedAudience?.slug);
    const rowAudience = selectedInPair ?? audience;
    return (
      <FormControlLabel
        key={pair ? pair.key : audience.slug}
        value={rowAudience.slug}
        disabled={!!frozen && !isGroupsSlug(audience.slug)}
        control={<Radio size="small" />}
        onChange={() => handleChoose(rowAudience)}
        sx={{ alignItems: "flex-start", m: 0, py: 0.5, "& .MuiRadio-root": { pt: 0.5 } }}
        label={
          <Box>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {pair ? t(`pairs.${pair.key}.title`) : localised(audience, locale)}
            </Typography>
            <Typography variant="caption" sx={{ color: "text.secondary" }}>
              {pair ? t(`pairs.${pair.key}.desc`) : t(`options.${option.key}.desc`)}
            </Typography>
          </Box>
        }
      />
    );
  };

  return (
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, gap: 2.5 }}>
      <Box>
        <RadioGroup aria-label={t("title")} value={selectedAudience?.slug ?? ""}>
          {GROUP_ORDER.map((group) => (
            <Box key={group} sx={{ mb: 1.5, display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
              <Typography
                variant="caption"
                sx={{ display: "block", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary", mb: 0.25 }}
              >
                {t(GROUP_LABEL_KEY[group])}
              </Typography>
              {audiences.filter((a) => optionForAudience(a).group === group).map(renderRow)}
            </Box>
          ))}
        </RadioGroup>
        {frozen && (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {translate("padmakara.events.audienceFrozenHint")}
          </Typography>
        )}
      </Box>

      <Box sx={{ backgroundColor: "#FAFAF7", borderRadius: 2, p: 2.5, alignSelf: "start" }}>
        {current ? (
          <>
            {!current.groups && selectedAudience && (
              <>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {localised(selectedAudience, locale)}
                </Typography>
                <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
                  {t(`options.${current.key}.panel`)}
                </Typography>
              </>
            )}

            {showMembershipSwitch && (
              <Box sx={{ mb: 1 }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={requiresMembership}
                      onChange={(_, on) => handleRequiresMembership(on)}
                      // Cast: data-* attributes are not part of the typed input props.
                      slotProps={{ input: { "data-testid": "requires-membership" } as Record<string, string> }}
                    />
                  }
                  label={t("requiresMembership")}
                />
                <Typography variant="caption" sx={{ display: "block", color: "text.secondary", ml: 6 }}>
                  {t("requiresMembershipHint")}
                </Typography>
              </Box>
            )}

            {current.canSell && (
              <Box sx={{ mb: 1 }}>
                <FormControlLabel
                  control={<Switch checked={othersCanBuy} onChange={(_, on) => handleOthersCanBuy(on)} />}
                  label={t("othersCanBuy")}
                />
                <Typography variant="caption" sx={{ display: "block", color: "text.secondary", ml: 6 }}>
                  {t(`options.${current.key}.othersHint`)}
                </Typography>
              </Box>
            )}

            {showPrice && (
              <TextField
                label={translate("padmakara.eventSale.price")}
                value={priceText}
                onChange={(e) => handlePrice(e.target.value)}
                error={priceInvalid}
                helperText={priceInvalid ? translate("padmakara.eventSale.priceMin") : undefined}
                required={!!current.paid}
                size="small"
                sx={{ mt: 1, width: 180 }}
                slotProps={{
                  htmlInput: { inputMode: "decimal" },
                  input: { startAdornment: <InputAdornment position="start">€</InputAdornment> },
                }}
              />
            )}

            {eventId !== undefined && sold && (
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

            {eventId !== undefined && showStats && stats && (
              <Box sx={{ display: "flex", gap: 4, flexWrap: "wrap", mt: 2 }}>
                <Stat label={translate("padmakara.eventSale.statSold")} value={String(stats.paidCount)} />
                <Stat label={translate("padmakara.eventSale.statCollected")} value={formatEuros(stats.collectedCents)} />
                <Stat label={translate("padmakara.eventSale.statPending")} value={String(stats.pendingCount)} />
              </Box>
            )}
          </>
        ) : (
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("pickOne")}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <Box>
    <Typography variant="h6" sx={{ lineHeight: 1.2 }}>{value}</Typography>
    <Typography variant="caption" sx={{ color: "text.secondary" }}>{label}</Typography>
  </Box>
);
