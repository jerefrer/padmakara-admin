/**
 * Author names to suggest on a publication: every name already used on a
 * publication, then the teachers ("Name (ABBR)") nobody has used yet.
 */

import { useEffect, useState } from "react";
import { useDataProvider } from "react-admin";
import { authFetch } from "../utils/authFetch";
import { authorKey } from "./AuthorsInput";

interface TeacherOption {
  id: number;
  name: string;
  abbreviation: string;
}

export function useAuthorSuggestions(): string[] {
  const dataProvider = useDataProvider();
  const [used, setUsed] = useState<string[]>([]);
  const [teachers, setTeachers] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch("/api/admin/publications/authors");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = (await res.json()) as { name: string; count: number }[];
        if (!cancelled) setUsed(rows.map((r) => r.name));
      } catch (err) {
        // Suggestions only: without them the field still takes typed names.
        console.error("Author suggestions load failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    dataProvider
      .getList<TeacherOption>("teachers", {
        pagination: { page: 1, perPage: 500 },
        sort: { field: "name", order: "ASC" },
        filter: {},
      })
      .then(({ data }) => setTeachers(data.map((t) => `${t.name} (${t.abbreviation})`)))
      .catch((err) => console.error("Teacher suggestions load failed:", err));
  }, [dataProvider]);

  const seen = new Set(used.map(authorKey));
  return [...used, ...teachers.filter((t) => !seen.has(authorKey(t)))];
}
