import { describe, expect, it } from "vitest";

import { normalizeDesktopSecretValue, shouldPersistDesktopSecrets } from "./secretStorage";

describe("normalizeDesktopSecretValue", () => {
  it("trims and keeps non-empty secret values", () => {
    expect(normalizeDesktopSecretValue("  sk-kimi-secret  ")).toBe("sk-kimi-secret");
  });

  it("returns null for empty secret values", () => {
    expect(normalizeDesktopSecretValue("   ")).toBeNull();
  });
});

describe("shouldPersistDesktopSecrets", () => {
  it("persists encrypted secrets on macOS and Windows when encryption is available", () => {
    expect(
      shouldPersistDesktopSecrets({
        platform: "darwin",
        encryptionAvailable: true,
        selectedStorageBackend: null,
      }),
    ).toBe(true);
    expect(
      shouldPersistDesktopSecrets({
        platform: "win32",
        encryptionAvailable: true,
        selectedStorageBackend: null,
      }),
    ).toBe(true);
  });

  it("rejects Linux basic_text fallback storage", () => {
    expect(
      shouldPersistDesktopSecrets({
        platform: "linux",
        encryptionAvailable: true,
        selectedStorageBackend: "basic_text",
      }),
    ).toBe(false);
  });

  it("requires encryption availability on all platforms", () => {
    expect(
      shouldPersistDesktopSecrets({
        platform: "linux",
        encryptionAvailable: false,
        selectedStorageBackend: "gnome_libsecret",
      }),
    ).toBe(false);
  });
});
