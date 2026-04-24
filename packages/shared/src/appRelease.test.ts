import { describe, expect, it } from "vitest";

import {
  getVersionPrereleaseTag,
  isForkPrereleaseVersion,
  isPrereleaseVersion,
  resolveAppReleaseBranding,
} from "./appRelease";

describe("getVersionPrereleaseTag", () => {
  it("returns null for stable versions", () => {
    expect(getVersionPrereleaseTag("1.2.3")).toBeNull();
  });

  it("returns the prerelease tag for tagged builds", () => {
    expect(getVersionPrereleaseTag("0.0.11-alpha.3")).toBe("alpha");
  });
});

describe("isPrereleaseVersion", () => {
  it("returns true for tagged prerelease versions", () => {
    expect(isPrereleaseVersion("0.0.11-alpha.3")).toBe(true);
  });

  it("returns false for stable versions", () => {
    expect(isPrereleaseVersion("1.2.3")).toBe(false);
  });
});

describe("isForkPrereleaseVersion", () => {
  it("returns true for fork prerelease versions", () => {
    expect(isForkPrereleaseVersion("0.0.11-fork.3")).toBe(true);
  });

  it("returns false for non-fork prerelease versions", () => {
    expect(isForkPrereleaseVersion("0.0.11-alpha.1")).toBe(false);
  });
});

describe("resolveAppReleaseBranding", () => {
  it("keeps local dev-server sessions on unified Draft branding", () => {
    expect(resolveAppReleaseBranding({ version: "1.2.3", isDevelopment: true })).toEqual({
      stageLabel: "Draft",
      displayName: "Draft",
      productName: "Draft",
      appId: "com.t3tools.t4code",
      stateDirName: "t4code",
      userDataDirName: "t4code",
    });
  });

  it("keeps prerelease packages on unified Draft branding", () => {
    expect(resolveAppReleaseBranding({ version: "0.0.11-alpha.3", isDevelopment: false })).toEqual({
      stageLabel: "Draft",
      displayName: "Draft",
      productName: "Draft",
      appId: "com.t3tools.t4code",
      stateDirName: "t4code",
      userDataDirName: "t4code",
    });
  });

  it("keeps fork prerelease packages on unified Draft branding", () => {
    expect(resolveAppReleaseBranding({ version: "0.0.11-fork.3", isDevelopment: false })).toEqual({
      stageLabel: "Draft",
      displayName: "Draft",
      productName: "Draft",
      appId: "com.t3tools.t4code",
      stateDirName: "t4code",
      userDataDirName: "t4code",
    });
  });

  it("keeps stable packaged builds on unified Draft branding", () => {
    expect(resolveAppReleaseBranding({ version: "1.2.3", isDevelopment: false })).toEqual({
      stageLabel: "Draft",
      displayName: "Draft",
      productName: "Draft",
      appId: "com.t3tools.t4code",
      stateDirName: "t4code",
      userDataDirName: "t4code",
    });
  });
});
