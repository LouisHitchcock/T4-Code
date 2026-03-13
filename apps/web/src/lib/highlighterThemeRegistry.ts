import { registerCustomTheme } from "@pierre/diffs";

import { LILAC_THEME, LILAC_THEME_NAME } from "./lilacTheme";

let sharedHighlighterThemesRegistered = false;

export function ensureSharedHighlighterThemesRegistered(): void {
  if (sharedHighlighterThemesRegistered) {
    return;
  }

  registerCustomTheme(LILAC_THEME_NAME, () => Promise.resolve(LILAC_THEME));
  sharedHighlighterThemesRegistered = true;
}
