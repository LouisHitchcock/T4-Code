import { describe, expect, it } from "vitest";

import { getLegacyUserDataDirNames, resolveDesktopUserDataPath } from "./userDataPath";

describe("getLegacyUserDataDirNames", () => {
  it("prioritizes the current app display name before older branded names", () => {
    expect(getLegacyUserDataDirNames("T3 Code (Dev)")).toEqual([
      "T3 Code (Dev)",
      "T3 Code (Alpha)",
      "T3 Code",
    ]);
  });

  it("includes both older branded names for migration coverage", () => {
    expect(getLegacyUserDataDirNames("T3 Code (Alpha)")).toEqual([
      "T3 Code (Alpha)",
      "T3 Code (Dev)",
      "T3 Code",
    ]);
  });
});

describe("resolveDesktopUserDataPath", () => {
  it("prefers an existing legacy dir over the clean userData dir", () => {
    const existingPaths = new Set(["/config/T3 Code (Alpha)"]);

    expect(
      resolveDesktopUserDataPath({
        appDataBase: "/config",
        userDataDirName: "t3code-dev",
        legacyDirNames: getLegacyUserDataDirNames("T3 Code (Dev)"),
        pathExists: (path) => existingPaths.has(path),
      }),
    ).toBe("/config/T3 Code (Alpha)");
  });

  it("falls back to the clean userData dir when no legacy dir exists", () => {
    expect(
      resolveDesktopUserDataPath({
        appDataBase: "/config",
        userDataDirName: "t3code-dev",
        legacyDirNames: getLegacyUserDataDirNames("T3 Code (Dev)"),
        pathExists: () => false,
      }),
    ).toBe("/config/t3code-dev");
  });

  it("can recover the old plain productName directory too", () => {
    const existingPaths = new Set(["/config/T3 Code"]);

    expect(
      resolveDesktopUserDataPath({
        appDataBase: "/config",
        userDataDirName: "t3code",
        legacyDirNames: getLegacyUserDataDirNames("T3 Code (Alpha)"),
        pathExists: (path) => existingPaths.has(path),
      }),
    ).toBe("/config/T3 Code");
  });
});
