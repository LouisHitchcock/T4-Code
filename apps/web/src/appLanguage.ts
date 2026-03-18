export const APP_LANGUAGE_OPTIONS = ["en", "fa"] as const;
export type AppLanguage = (typeof APP_LANGUAGE_OPTIONS)[number];
export type AppLanguageDirection = "ltr" | "rtl";

export const DEFAULT_APP_LANGUAGE: AppLanguage = "en";

const APP_LANGUAGE_DETAILS = {
  en: {
    label: "English",
    nativeLabel: "English",
    locale: "en-US",
    lang: "en",
    dir: "ltr",
  },
  fa: {
    label: "Persian",
    nativeLabel: "فارسی",
    locale: "fa-IR",
    lang: "fa",
    dir: "rtl",
  },
} as const satisfies Record<
  AppLanguage,
  {
    label: string;
    nativeLabel: string;
    locale: string;
    lang: string;
    dir: AppLanguageDirection;
  }
>;

export function getAppLanguageDetails(language: AppLanguage) {
  return APP_LANGUAGE_DETAILS[language];
}

export function applyDocumentLanguage(
  language: AppLanguage,
  root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement,
): void {
  if (!root) {
    return;
  }

  const details = getAppLanguageDetails(language);
  root.lang = details.lang;
  root.dir = details.dir;
  root.dataset.language = language;
}
