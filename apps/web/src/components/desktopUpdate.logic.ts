import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import { type AppLanguage } from "../appLanguage";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "downloaded") {
    return "install";
  }
  if (state.status === "error") {
    if (state.errorContext === "install" && state.downloadedVersion) {
      return "install";
    }
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(
  state: DesktopUpdateState,
  language: AppLanguage = "en",
): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return language === "fa"
      ? "این نصب از معماری درست استفاده می کند."
      : "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return language === "fa"
      ? "این مک Apple Silicon دارد، اما CUT3 هنوز نسخه اینتل را با Rosetta اجرا می کند. برای رفتن به نسخه بومی Apple Silicon، به روزرسانی موجود را دانلود کنید."
      : "This Mac has Apple Silicon, but CUT3 is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return language === "fa"
      ? "این مک Apple Silicon دارد، اما CUT3 هنوز نسخه اینتل را با Rosetta اجرا می کند. برای نصب نسخه دانلودشده Apple Silicon دوباره راه اندازی کنید."
      : "This Mac has Apple Silicon, but CUT3 is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return language === "fa"
    ? "این مک Apple Silicon دارد، اما CUT3 هنوز نسخه اینتل را با Rosetta اجرا می کند. به روزرسانی بعدی برنامه آن را با نسخه بومی Apple Silicon جایگزین می کند."
    : "This Mac has Apple Silicon, but CUT3 is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

export function getDesktopUpdateButtonTooltip(
  state: DesktopUpdateState,
  language: AppLanguage = "en",
): string {
  if (state.status === "available") {
    return language === "fa"
      ? `به روزرسانی ${state.availableVersion ?? "موجود"} برای دانلود آماده است`
      : `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return language === "fa"
      ? `در حال دانلود به روزرسانی${progress}`
      : `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    return language === "fa"
      ? `به روزرسانی ${state.downloadedVersion ?? state.availableVersion ?? "آماده"} دانلود شد. برای راه اندازی دوباره و نصب کلیک کنید.`
      : `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Click to restart and install.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return language === "fa"
        ? `دانلود ${state.availableVersion} انجام نشد. برای تلاش دوباره کلیک کنید.`
        : `Download failed for ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return language === "fa"
        ? `نصب ${state.downloadedVersion} انجام نشد. برای تلاش دوباره کلیک کنید.`
        : `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    return state.message ?? (language === "fa" ? "به روزرسانی انجام نشد" : "Update failed");
  }
  return language === "fa" ? "به روزرسانی در دسترس است" : "Update available";
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return result.accepted && !result.completed;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}
