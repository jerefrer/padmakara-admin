/**
 * Multi-select picker that stays open while the admin ticks several options.
 * Every option carries a checkbox (ticked = selected), the picks stay in the
 * field as chips, and typing still filters the list. Selected options are
 * deliberately kept in the list (no filterSelectedOptions) so a pick can be
 * unticked from it.
 * Keyboard: arrows move, Enter toggles the highlighted option, Escape closes.
 */

import type { ReactNode } from "react";
import Autocomplete, { type AutocompleteProps } from "@mui/material/Autocomplete";
import Checkbox from "@mui/material/Checkbox";

export type CheckboxMultiSelectProps<T> = Omit<
  AutocompleteProps<T, true, false, false>,
  "multiple" | "disableCloseOnSelect" | "filterSelectedOptions" | "renderOption"
> & {
  /** Content of an option next to its checkbox; defaults to the option's label. */
  renderOptionContent?: (option: T) => ReactNode;
};

export function CheckboxMultiSelect<T>({
  renderOptionContent,
  getOptionLabel,
  ...rest
}: CheckboxMultiSelectProps<T>) {
  const labelOf = (o: T): string =>
    getOptionLabel ? getOptionLabel(o) : String((o as { label?: unknown }).label ?? o);
  return (
    <Autocomplete<T, true, false, false>
      {...rest}
      multiple
      disableCloseOnSelect
      getOptionLabel={labelOf}
      renderOption={({ key, ...props }, option, { selected }) => (
        <li key={key} {...props}>
          <Checkbox
            checked={selected}
            size="small"
            tabIndex={-1}
            disableRipple
            sx={{ mr: 1, p: 0.5 }}
          />
          {renderOptionContent ? renderOptionContent(option) : labelOf(option)}
        </li>
      )}
    />
  );
}
