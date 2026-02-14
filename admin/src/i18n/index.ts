import polyglotI18nProvider from "ra-i18n-polyglot";
import { en } from "./en";
import { pt } from "./pt";

const translations: Record<string, any> = { en, pt };

export const i18nProvider = polyglotI18nProvider(
  (locale) => translations[locale] ?? en,
  "en",
);
