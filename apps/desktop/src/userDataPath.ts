import Path from "node:path";

const LEGACY_USER_DATA_DIR_NAMES = ["T3 Code", "T3 Code (Alpha)", "T3 Code (Dev)"] as const;

function joinUserDataPath(basePath: string, segment: string): string {
  const pathModule = basePath.includes("/") ? Path.posix : Path.win32;
  return pathModule.join(basePath, segment);
}

export function getLegacyUserDataDirNames(args: { appDisplayName: string }): string[] {
  return Array.from(new Set([args.appDisplayName, ...LEGACY_USER_DATA_DIR_NAMES]));
}

export function resolveDesktopUserDataPath(args: {
  appDataBase: string;
  userDataDirName: string;
  legacyDirNames: readonly string[];
  pathExists: (path: string) => boolean;
}): string {
  for (const legacyDirName of args.legacyDirNames) {
    const legacyPath = joinUserDataPath(args.appDataBase, legacyDirName);
    if (args.pathExists(legacyPath)) {
      return legacyPath;
    }
  }

  return joinUserDataPath(args.appDataBase, args.userDataDirName);
}
