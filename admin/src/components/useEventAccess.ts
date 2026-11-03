/** Loads the access list, pending orders and sale stats of one event. */

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../utils/authFetch";

export interface AccessGrant {
  userId: number;
  email: string;
  name: string;
  /** purchase | free | manual */
  source: string;
  orderId: number | null;
  /** mb | mbw | cc … once known (purchases only). */
  method: string | null;
  amountCents: number | null;
  createdAt: string;
  grantedBy: { id: number; email: string | null; name: string } | null;
}

export interface PendingOrder {
  id: number;
  email: string;
  name: string;
  amountCents: number;
  createdAt: string;
}

export interface SaleStats {
  paidCount: number;
  collectedCents: number;
  pendingCount: number;
}

export interface EventAccess {
  grants: AccessGrant[];
  pendingOrders: PendingOrder[];
  stats: SaleStats;
}

export function useEventAccess(eventId: number | undefined): {
  access: EventAccess | null;
  reload: () => void;
} {
  const [access, setAccess] = useState<EventAccess | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (eventId === undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`/api/admin/events/${eventId}/access`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as EventAccess;
        if (!cancelled) setAccess(json);
      } catch (err) {
        // Informational cards: a failed load just hides them.
        console.error("Event access load failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, tick]);

  return { access, reload };
}
