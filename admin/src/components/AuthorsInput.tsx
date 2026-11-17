/**
 * Authors of a publication, one chip per author. Names are picked from the
 * ones already in use (matched ignoring case and diacritics, so "manjusri"
 * finds "Mañjuśrī"), or typed and confirmed with Enter for a new author. A
 * typed name that only differs from a suggestion by case or diacritics takes
 * the suggestion's spelling, so the same person is not stored two ways.
 */

import { Autocomplete, Chip, TextField, createFilterOptions } from "@mui/material";
import { useState } from "react";

/** How two spellings of one name compare: no case, no diacritics, single spaces. */
export function authorKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Trims, takes a suggestion's spelling where one matches, and drops blanks and repeats. */
export function canonicalAuthors(names: string[], suggestions: string[]): string[] {
  const byKey = new Map(suggestions.map((s) => [authorKey(s), s]));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.replace(/\s+/g, " ").trim();
    const key = authorKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(byKey.get(key) ?? name);
  }
  return result;
}

const filterOptions = createFilterOptions<string>({ ignoreAccents: true, ignoreCase: true, trim: true });

export function AuthorsInput({
  value,
  onChange,
  suggestions,
  label,
  placeholder,
  helperText,
}: {
  value: string[];
  onChange: (authors: string[]) => void;
  suggestions: string[];
  label: string;
  placeholder?: string;
  helperText?: string;
}) {
  const [input, setInput] = useState("");

  const commit = (names: string[]) => onChange(canonicalAuthors(names, suggestions));

  return (
    <Autocomplete
      multiple
      freeSolo
      filterSelectedOptions
      options={suggestions}
      filterOptions={filterOptions}
      value={value}
      inputValue={input}
      onInputChange={(_, text, reason) => {
        if (reason !== "reset") setInput(text);
      }}
      onChange={(_, next) => {
        setInput("");
        commit(next);
      }}
      // A name typed but not confirmed with Enter is kept rather than lost on Save.
      onBlur={() => {
        if (input.trim()) commit([...value, input]);
        setInput("");
      }}
      renderValue={(names, getItemProps) =>
        names.map((name, index) => {
          const { key, ...rest } = getItemProps({ index });
          return <Chip key={key} label={name} size="small" {...rest} />;
        })
      }
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholder}
          helperText={helperText}
          slotProps={{ inputLabel: { shrink: true } }}
        />
      )}
      data-testid="authors-input"
    />
  );
}
