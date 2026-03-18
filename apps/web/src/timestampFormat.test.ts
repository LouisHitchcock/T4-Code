import { describe, expect, it, vi } from "vitest";

import { getTimestampFormatOptions } from "./timestampFormat";

describe("getTimestampFormatOptions", () => {
  it("omits hour12 when locale formatting is requested", () => {
    expect(getTimestampFormatOptions("locale", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  });

  it("builds a 12-hour formatter with seconds when requested", () => {
    expect(getTimestampFormatOptions("12-hour", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  });

  it("builds a 24-hour formatter without seconds when requested", () => {
    expect(getTimestampFormatOptions("24-hour", false)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
  });

  it("uses the selected app language locale for formatter creation", async () => {
    vi.resetModules();
    vi.doMock("./appSettings", async () => {
      const actual = await vi.importActual<typeof import("./appSettings")>("./appSettings");

      return {
        ...actual,
        getAppSettingsSnapshot: () => ({
          ...actual.getAppSettingsSnapshot(),
          language: "fa" as const,
        }),
      };
    });

    try {
      const { getTimestampFormatterLocale } = await import("./timestampFormat");
      expect(getTimestampFormatterLocale()).toBe("fa-IR");
    } finally {
      vi.doUnmock("./appSettings");
      vi.resetModules();
    }
  });
});
