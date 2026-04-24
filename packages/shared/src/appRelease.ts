const VERSION_PRERELEASE_PATTERN = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/;
const DEFAULT_DESKTOP_PRODUCT_NAME = "Draft";
const DEFAULT_DESKTOP_APP_ID = "com.t3tools.t4code";
const DEFAULT_STAGE_LABEL = "Draft";
const DEFAULT_STATE_DIR_NAME = "t4code";
const DEFAULT_USER_DATA_DIR_NAME = "t4code";

export interface AppReleaseBrandingInput {
  readonly version: string;
  readonly isDevelopment: boolean;
}

export interface AppReleaseBranding {
  readonly stageLabel: "Draft";
  readonly displayName: string;
  readonly productName: string;
  readonly appId: string;
  readonly stateDirName: string;
  readonly userDataDirName: string;
}

export function getVersionPrereleaseTag(version: string): string | null {
  const match = VERSION_PRERELEASE_PATTERN.exec(version);
  if (!match) {
    return null;
  }

  const prereleaseTag = match[1]?.split(".")[0] ?? "";
  if (prereleaseTag.length === 0 || !/[A-Za-z]/.test(prereleaseTag)) {
    return null;
  }

  return prereleaseTag;
}

export function isForkPrereleaseVersion(version: string): boolean {
  return getVersionPrereleaseTag(version) === "fork";
}

export function isPrereleaseVersion(version: string): boolean {
  return getVersionPrereleaseTag(version) !== null;
}

export function resolveAppReleaseBranding(_input: AppReleaseBrandingInput): AppReleaseBranding {
  return {
    stageLabel: DEFAULT_STAGE_LABEL,
    displayName: DEFAULT_DESKTOP_PRODUCT_NAME,
    productName: DEFAULT_DESKTOP_PRODUCT_NAME,
    appId: DEFAULT_DESKTOP_APP_ID,
    stateDirName: DEFAULT_STATE_DIR_NAME,
    userDataDirName: DEFAULT_USER_DATA_DIR_NAME,
  };
}
