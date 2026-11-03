import { AppError } from "./errors.ts";

export const MIN_PRICE_CENTS = 100;

type SaleMode = "none" | "free" | "paid";

/**
 * Resolve the sale columns to write for an event create/update.
 * `sent` holds only the fields present in the request; `current` is the stored
 * sale mode (used when only the price is sent). Returns the columns to set:
 * a paid event needs priceCents >= 100, any other mode clears the price.
 */
export function resolveSaleSettings(
  sent: { saleMode?: SaleMode; priceCents?: number | null },
  current: { saleMode: string } | null,
): { saleMode?: SaleMode; priceCents?: number | null } {
  const touchesSale = sent.saleMode !== undefined || sent.priceCents !== undefined;
  if (!touchesSale) return {};

  const mode = (sent.saleMode ?? current?.saleMode ?? "none") as SaleMode;
  if (mode !== "paid") {
    return { ...(sent.saleMode !== undefined ? { saleMode: mode } : {}), priceCents: null };
  }
  if (sent.priceCents == null || sent.priceCents < MIN_PRICE_CENTS) {
    throw AppError.badRequest(
      `A paid event needs a price of at least ${MIN_PRICE_CENTS} cents`,
      "INVALID_PRICE",
    );
  }
  return { saleMode: mode, priceCents: sent.priceCents };
}
