import { useEffect, useState } from "react";
import { authFetch } from "../../utils/authFetch";
import type { DateRange, TeachingDetail } from "./types";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: TeachingDetail };

/** Loads one teaching's per-item statistics for the period; idle while no teaching is selected. */
export function useTeachingDetail(eventId: number | null, range: DateRange): State {
  const [state, setState] = useState<State>({ status: "idle" });

  useEffect(() => {
    if (eventId === null) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    authFetch(`/api/admin/statistics/events/${eventId}?from=${range.from}&to=${range.to}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as TeachingDetail;
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, range.from, range.to]);

  return state;
}
