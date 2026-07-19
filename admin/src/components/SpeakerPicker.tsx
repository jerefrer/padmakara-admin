/**
 * SpeakerChipPicker — the compact speaker control of the inline track
 * editors: a chip that opens a fuzzy-searchable teacher list. The search
 * matches the abbreviation, the full name and the name's initials (e.g.
 * "jk" finds "Jigme Khyentse Rinpoche"), so a long roster stays one or two
 * keystrokes away. A 2–5 letter query that matches no known abbreviation can
 * be used as-is (free entry), preserving parity with the parser's output for
 * speakers that are not in the roster yet.
 */

import { useMemo, useState } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import InputBase from "@mui/material/InputBase";
import MenuItem from "@mui/material/MenuItem";
import Popover from "@mui/material/Popover";
import Typography from "@mui/material/Typography";
import { useTranslate } from "react-admin";

export interface SpeakerOption {
  id: number;
  name: string;
  abbreviation: string;
}

const norm = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/**
 * Score one teacher against a query — higher is better, null is no match.
 * Recognizes the abbreviation, the full name (whole, word starts, plain
 * substring), the initials of the name's words, and finally an in-order
 * character subsequence of the name as the loosest fuzzy tier.
 */
export function fuzzyMatchTeacher(t: SpeakerOption, rawQuery: string): number | null {
  const q = norm(rawQuery.trim());
  if (!q) return 0;
  const abbr = norm(t.abbreviation);
  const name = norm(t.name);
  const words = name.split(/\s+/).filter(Boolean);
  const initials = words.map((w) => w[0]!).join("");

  if (abbr === q) return 100;
  if (abbr.startsWith(q)) return 90;
  if (initials.startsWith(q)) return 80;
  if (name.startsWith(q)) return 75;
  if (words.some((w) => w.startsWith(q))) return 70;
  if (abbr.includes(q)) return 60;
  if (name.includes(q)) return 55;

  // Subsequence: query characters appear in order somewhere in the name.
  let i = 0;
  for (const ch of name) {
    if (ch === q[i]) i++;
    if (i === q.length) return 40;
  }
  return null;
}

export function fuzzyFilterTeachers(
  teachers: SpeakerOption[],
  query: string,
): SpeakerOption[] {
  return teachers
    .map((t) => ({ t, score: fuzzyMatchTeacher(t, query) }))
    .filter((x): x is { t: SpeakerOption; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    .map((x) => x.t);
}

interface SpeakerChipPickerProps {
  /** Stored speaker abbreviation, or null for none. */
  value: string | null;
  teachers: SpeakerOption[];
  onChange: (abbreviation: string | null) => void;
  /** Lets the host editor skip its blur-to-close handling while the picker's
   *  portal holds the focus. */
  onOpenChange?: (open: boolean) => void;
}

export function SpeakerChipPicker({
  value,
  teachers,
  onChange,
  onOpenChange,
}: SpeakerChipPickerProps) {
  const translate = useTranslate();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const options = useMemo(() => fuzzyFilterTeachers(teachers, query), [teachers, query]);

  // Free entry: a short letter-only query that is no known abbreviation can
  // be stored as-is (the importer emits such speakers for roster gaps).
  const trimmed = query.trim();
  const freeAbbr =
    /^[a-zA-Z]{2,5}$/.test(trimmed) &&
    !teachers.some((t) => t.abbreviation.toLowerCase() === trimmed.toLowerCase())
      ? trimmed.toUpperCase()
      : null;

  interface Entry {
    key: string;
    abbr: string | null;
    primary: string;
    secondary?: string;
  }
  const entries: Entry[] = [
    { key: "__none__", abbr: null, primary: translate("padmakara.tracks.noSpeaker") },
    ...options.map((t) => ({
      key: `t${t.id}`,
      abbr: t.abbreviation,
      primary: t.name,
      secondary: t.abbreviation,
    })),
    ...(freeAbbr
      ? [
          {
            key: "__free__",
            abbr: freeAbbr,
            primary: translate("padmakara.tracks.useAbbreviation", { abbr: freeAbbr }),
          },
        ]
      : []),
  ];

  const openPicker = (e: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(e.currentTarget);
    setQuery("");
    setHighlight(0);
    onOpenChange?.(true);
  };

  const close = () => {
    setAnchorEl(null);
    onOpenChange?.(false);
  };

  const pick = (abbr: string | null) => {
    onChange(abbr);
    close();
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    // Keep picker keystrokes away from the host editor's Enter/Esc/arrows.
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, entries.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[highlight];
      if (entry) pick(entry.abbr);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const current = teachers.find((t) => t.abbreviation === value);

  return (
    <>
      <Chip
        size="small"
        variant="outlined"
        label={`${value || translate("padmakara.tracks.speaker")} ▾`}
        title={current?.name ?? undefined}
        onClick={openPicker}
        sx={{ height: 20, fontWeight: 600, "& .MuiChip-label": { px: 0.75, fontSize: "0.65rem" } }}
      />
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
      >
        <Box sx={{ width: 280, p: 1 }}>
          <InputBase
            autoFocus
            fullWidth
            value={query}
            placeholder={translate("padmakara.tracks.searchSpeaker")}
            onChange={(e) => {
              setQuery(e.target.value);
              // First real match, not "No speaker", once the admin types.
              setHighlight(e.target.value.trim() ? 1 : 0);
            }}
            onKeyDown={handleSearchKeyDown}
            sx={{
              fontSize: "0.85rem",
              px: 1,
              py: 0.5,
              mb: 0.5,
              borderRadius: 1.5,
              backgroundColor: "rgba(91,94,166,0.06)",
              border: "1px solid transparent",
              "&.Mui-focused": {
                backgroundColor: "background.paper",
                borderColor: "primary.main",
                boxShadow: "0 0 0 2px rgba(91,94,166,0.15)",
              },
              "& input": { p: 0 },
            }}
          />
          <Box sx={{ maxHeight: 280, overflowY: "auto" }}>
            {entries.map((entry, i) => (
              <MenuItem
                key={entry.key}
                dense
                selected={i === highlight}
                onClick={() => pick(entry.abbr)}
                onMouseEnter={() => setHighlight(i)}
                sx={{ borderRadius: 1, minHeight: 32 }}
              >
                <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.75, minWidth: 0 }}>
                  <Typography
                    variant="body2"
                    noWrap
                    sx={{ fontWeight: entry.abbr != null && entry.abbr === value ? 700 : 400 }}
                  >
                    {entry.primary}
                  </Typography>
                  {entry.secondary && (
                    <Typography variant="caption" sx={{ color: "text.secondary", flexShrink: 0 }}>
                      {entry.secondary}
                    </Typography>
                  )}
                </Box>
              </MenuItem>
            ))}
            {entries.length === 1 && !freeAbbr && (
              <Typography variant="caption" sx={{ color: "text.disabled", px: 1.5, py: 1, display: "block" }}>
                {translate("padmakara.tracks.noSpeakerMatch")}
              </Typography>
            )}
          </Box>
        </Box>
      </Popover>
    </>
  );
}
