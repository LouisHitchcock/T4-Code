import { type AppLanguage } from "./appLanguage";
import { APP_DISPLAY_NAME } from "./branding";

export function getServerConnectionBannerTitle(args: {
  retrying: boolean;
  isElectron: boolean;
  language: AppLanguage;
}): string {
  if (args.language === "fa") {
    if (args.retrying) {
      return "اتصال قطع شد";
    }

    return args.isElectron ? `در حال اتصال به ${APP_DISPLAY_NAME}` : "در حال اتصال به سرور محلی";
  }

  if (args.retrying) {
    return "Connection lost";
  }

  return args.isElectron ? `Connecting to ${APP_DISPLAY_NAME}` : "Connecting to local server";
}

export function getServerConnectionBannerDescription(args: {
  retrying: boolean;
  isElectron: boolean;
  language: AppLanguage;
}): string {
  if (args.language === "fa") {
    if (args.retrying) {
      return args.isElectron
        ? "برنامه به صورت خودکار دوباره اتصال وب سوکت را امتحان می کند. اگر این وضعیت ادامه داشت، CUT3 را دوباره راه اندازی کنید."
        : "برنامه به صورت خودکار دوباره اتصال وب سوکت را امتحان می کند. اگر این وضعیت ادامه داشت، سرور توسعه محلی را دوباره راه اندازی کنید.";
    }

    return args.isElectron
      ? "برنامه منتظر سرویس دسکتاپ بسته بندی شده است تا داده های زنده و اقدامات در دسترس شوند."
      : "برنامه منتظر سرور محلی است تا داده های زنده و اقدامات در دسترس شوند.";
  }

  if (args.retrying) {
    return args.isElectron
      ? "The app is retrying the websocket connection automatically. If this keeps happening, restart CUT3."
      : "The app is retrying the websocket connection automatically. If this keeps happening, restart the local dev server.";
  }

  return args.isElectron
    ? "The app is waiting for the bundled desktop service before live data and actions become available."
    : "The app is waiting for the local server before live data and actions become available.";
}
