/** Loads, adds and removes the people of one list (event participants, user group members). */

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../utils/authFetch";

export interface BatchMember {
  id: number;
  email: string;
  name: string;
  registeredAt: string;
}

export interface BatchAddResult {
  added: string[];
  alreadyHad: string[];
  /** Addresses whose account was just created (also in `added`). */
  created: string[];
  invalid: string[];
}

export function useBatchMembers(endpoint: string) {
  const [members, setMembers] = useState<BatchMember[] | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(endpoint);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as BatchMember[];
        if (!cancelled) setMembers(json);
      } catch (err) {
        // The card still lets the admin add people; a failed load just shows an empty list.
        console.error("Member list load failed:", err);
        if (!cancelled) setMembers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, tick]);

  /** Throws on a failed request; the caller reports it. */
  const add = useCallback(
    async (emails: string[]): Promise<BatchAddResult> => {
      const res = await authFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as BatchAddResult;
      reload();
      return result;
    },
    [endpoint, reload],
  );

  /** Throws on a failed request; the caller reports it. */
  const remove = useCallback(
    async (userId: number): Promise<void> => {
      const res = await authFetch(`${endpoint}/${userId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      reload();
    },
    [endpoint, reload],
  );

  return { members, add, remove, reload };
}
