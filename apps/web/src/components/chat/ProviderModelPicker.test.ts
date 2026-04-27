import { describe, expect, it } from "vitest";
import { AVAILABLE_PROVIDER_OPTIONS } from "./ProviderModelPicker";

describe("ProviderModelPicker AVAILABLE_PROVIDER_OPTIONS", () => {
  it("includes all currently available providers instead of codex-only", () => {
    expect(AVAILABLE_PROVIDER_OPTIONS.map((option) => option.value)).toEqual([
      "codex",
      "opencode",
      "openrouter",
      "copilot",
      "kimi",
      "pi",
    ]);
  });

  it("keeps codex and opencode prioritized first", () => {
    expect(AVAILABLE_PROVIDER_OPTIONS[0]?.value).toBe("codex");
    expect(AVAILABLE_PROVIDER_OPTIONS[1]?.value).toBe("opencode");
  });
});
