import { useTranslate } from "react-admin";
import { Typography, type TypographyProps } from "@mui/material";

/** Stands in for the value while translating; it cannot occur in a translation. */
const MARK = "\u0000";

/**
 * A translated sentence with one placeholder shown in bold, e.g. the name of
 * the record a dialog is about to delete. The value is a React child, never
 * HTML: names are free text, and polyglot interpolates them unescaped, so
 * putting the translation through dangerouslySetInnerHTML would run any
 * markup a name carries in the reader's browser.
 */
export function EmphasizedMessage({
  messageKey,
  placeholder,
  value,
  ...typographyProps
}: {
  messageKey: string;
  placeholder: string;
  value: string;
} & TypographyProps) {
  const translate = useTranslate();
  const [before, after] = translate(messageKey, { [placeholder]: MARK }).split(MARK);
  return (
    <Typography {...typographyProps}>
      {before}
      {after !== undefined && <strong>{value}</strong>}
      {after}
    </Typography>
  );
}
