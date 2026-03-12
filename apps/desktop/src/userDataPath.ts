import Path from "node:path";

const DESKTOP_PRODUCT_NAME = "T3 Code";
const LEGACY_DESKTOP_DISPLAY_NAMES = ["T3 Code (Alpha)", "T3 Code (Dev)"] as const;

export function getLegacyUserDataDirNames(appDisplayName: string): string[] {
  return Array.from(
    new Set([appDisplayName, ...LEGACY_DESKTOP_DISPLAY_NAMES, DESKTOP_PRODUCT_NAME]),
  );
}

export function resolveDesktopUserDataPath(args: {
  appDataBase: string;
  userDataDirName: string;
  legacyDirNames: readonly string[];
  pathExists: (path: string) => boolean;
}): string {
  for (const legacyDirName of args.legacyDirNames) {
    const legacyPath = Path.join(args.appDataBase, legacyDirName);
    if (args.pathExists(legacyPath)) {
      return legacyPath;
    }
  }

  return Path.join(args.appDataBase, args.userDataDirName);
}
