import { describe, expect, it } from "vitest";

import {
  describeContextWindowState,
  extractUsedContextTokens,
  formatCompactTokenCount,
  parseThreadContextUsageSnapshot,
} from "./contextWindow";

describe("parseThreadContextUsageSnapshot", () => {
  it("returns null for non-objects", () => {
    expect(parseThreadContextUsageSnapshot(null)).toBeNull();
    expect(parseThreadContextUsageSnapshot("nope")).toBeNull();
  });

  it("extracts the structured snapshot fields", () => {
    expect(
      parseThreadContextUsageSnapshot({
        provider: "codex",
        kind: "thread",
        model: "gpt-5.4",
        usage: { totalTokens: 1234 },
      }),
    ).toEqual({
      provider: "codex",
      kind: "thread",
      observedAt: undefined,
      model: "gpt-5.4",
      usage: { totalTokens: 1234 },
      modelUsage: undefined,
    });
  });

  it("treats legacy raw usage payloads as thread snapshots", () => {
    expect(
      parseThreadContextUsageSnapshot({
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: { totalTokens: 1234 },
      }),
    ).toEqual({
      kind: "thread",
      usage: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: { totalTokens: 1234 },
      },
    });
  });
});

describe("extractUsedContextTokens", () => {
  it("prefers explicit total token counts when present", () => {
    expect(
      extractUsedContextTokens({
        kind: "thread",
        usage: { totalTokens: 27_800 },
      }),
    ).toBe(27_800);
  });

  it("reads nested token usage payloads from runtime snapshots", () => {
    expect(
      extractUsedContextTokens({
        kind: "thread",
        usage: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: { totalTokens: 27_800 },
        },
      }),
    ).toBe(27_800);
  });

  it("uses Codex thread usage `last` totals for current context usage", () => {
    expect(
      extractUsedContextTokens({
        kind: "thread",
        usage: {
          modelContextWindow: 400_000,
          total: {
            totalTokens: 180_000,
            inputTokens: 120_000,
            cachedInputTokens: 20_000,
            outputTokens: 40_000,
          },
          last: {
            totalTokens: 121_900,
            inputTokens: 92_000,
            cachedInputTokens: 8_000,
            outputTokens: 21_900,
          },
        },
      }),
    ).toBe(121_900);
  });

  it("sums vendor-specific token parts when total is absent", () => {
    expect(
      extractUsedContextTokens({
        kind: "turn",
        usage: {
          prompt_token_count: 10_000,
          candidates_token_count: 1_500,
          thoughts_token_count: 500,
          cached_content_token_count: 2_000,
        },
      }),
    ).toBe(14_000);
  });

  it("sums ACP prompt-usage fields when total is absent", () => {
    expect(
      extractUsedContextTokens({
        kind: "turn",
        usage: {
          inputTokens: 10_000,
          outputTokens: 1_500,
          thoughtTokens: 500,
          cachedReadTokens: 2_000,
          cachedWriteTokens: 100,
        },
      }),
    ).toBe(14_100);
  });

  it("sums Kimi raw token-usage fields when total is absent", () => {
    expect(
      extractUsedContextTokens({
        kind: "turn",
        usage: {
          token_usage: {
            input_other: 4_500,
            output: 900,
            input_cache_read: 350,
            input_cache_creation: 250,
          },
        },
      }),
    ).toBe(6_000);
  });
});

describe("formatCompactTokenCount", () => {
  it("formats compact token labels", () => {
    expect(formatCompactTokenCount(32_768)).toBe("32.8K");
    expect(formatCompactTokenCount(200_000)).toBe("200K");
    expect(formatCompactTokenCount(1_047_576)).toBe("1.05M");
  });
});

describe("describeContextWindowState", () => {
  it("returns the researched total for the selected provider and model", () => {
    expect(describeContextWindowState({ provider: "codex", model: "gpt-5.4" })).toMatchObject({
      totalTokens: 1_000_000,
      totalLabel: "1M",
      usedTokens: null,
    });
  });

  it("ignores usage snapshots captured for a different selected model", () => {
    expect(
      describeContextWindowState({
        provider: "copilot",
        model: "gpt-5.4",
        tokenUsage: {
          provider: "copilot",
          kind: "turn",
          model: "gpt-5.2",
          usage: { totalTokens: 12_000 },
        },
      }),
    ).toMatchObject({
      totalTokens: 1_000_000,
      usedTokens: null,
      usageScope: null,
    });
  });

  it("surfaces matching usage snapshots for the current selection", () => {
    expect(
      describeContextWindowState({
        provider: "kimi",
        model: "kimi-for-coding",
        tokenUsage: {
          provider: "kimi",
          kind: "turn",
          model: "kimi-for-coding",
          usage: { inputTokens: 20_000, outputTokens: 2_500 },
        },
      }),
    ).toMatchObject({
      totalTokens: 262_144,
      totalLabel: "262K",
      usedTokens: 22_500,
      usedLabel: "22.5K",
      usageScope: "turn",
    });
  });

  it("uses runtime Codex thread token usage for used and total context values", () => {
    expect(
      describeContextWindowState({
        provider: "codex",
        model: "gpt-5.3-codex",
        tokenUsage: {
          provider: "codex",
          kind: "thread",
          model: "gpt-5.3-codex",
          usage: {
            modelContextWindow: 400_000,
            total: {
              totalTokens: 180_000,
              inputTokens: 120_000,
              cachedInputTokens: 20_000,
              outputTokens: 40_000,
            },
            last: {
              totalTokens: 121_900,
              inputTokens: 92_000,
              cachedInputTokens: 8_000,
              outputTokens: 21_900,
            },
          },
        },
      }),
    ).toMatchObject({
      totalTokens: 400_000,
      totalLabel: "400K",
      usedTokens: 121_900,
      usedLabel: "121.9K",
      remainingTokens: 278_100,
      remainingLabel: "278.1K",
      usageScope: "thread",
    });
  });

  it("surfaces current GPT-5 Codex thread usage snapshots", () => {
    expect(
      describeContextWindowState({
        provider: "codex",
        model: "gpt-5-codex",
        tokenUsage: {
          provider: "codex",
          kind: "thread",
          model: "gpt-5-codex",
          usage: {
            modelContextWindow: 400_000,
            last: {
              totalTokens: 121_900,
            },
          },
        },
      }),
    ).toMatchObject({
      totalTokens: 400_000,
      totalLabel: "400K",
      usedTokens: 121_900,
      usedLabel: "121.9K",
      remainingTokens: 278_100,
      remainingLabel: "278.1K",
      usageScope: "thread",
    });
  });

  it("parses legacy persisted Codex payloads and computes remaining context", () => {
    expect(
      describeContextWindowState({
        provider: "codex",
        model: "gpt-5.4",
        tokenUsage: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              totalTokens: 13_308,
            },
            last: {
              totalTokens: 13_308,
            },
            modelContextWindow: 950_000,
          },
        },
      }),
    ).toMatchObject({
      totalTokens: 950_000,
      totalLabel: "950K",
      usedTokens: 13_308,
      usedLabel: "13.3K",
      remainingTokens: 936_692,
      remainingLabel: "936.7K",
      usageScope: "thread",
    });
  });

  it("uses ACP session usage updates for live thread used and total values", () => {
    expect(
      describeContextWindowState({
        provider: "copilot",
        model: "claude-sonnet-4.5",
        tokenUsage: {
          provider: "copilot",
          kind: "thread",
          model: "claude-sonnet-4.5",
          usage: {
            sessionUpdate: "usage_update",
            used: 54_321,
            size: 200_000,
          },
        },
      }),
    ).toMatchObject({
      totalTokens: 200_000,
      totalLabel: "200K",
      usedTokens: 54_321,
      usedLabel: "54.3K",
      remainingTokens: 145_679,
      remainingLabel: "145.7K",
      usageScope: "thread",
    });
  });

  it("uses Kimi context token snapshots when they are reported directly", () => {
    expect(
      describeContextWindowState({
        provider: "kimi",
        model: "kimi-for-coding",
        tokenUsage: {
          provider: "kimi",
          kind: "thread",
          model: "kimi-for-coding",
          usage: {
            context_usage: 0.16,
            context_tokens: 41_943,
            max_context_tokens: 262_144,
            token_usage: {
              input_other: 20_000,
              output: 1_250,
              input_cache_read: 500,
              input_cache_creation: 250,
            },
          },
        },
      }),
    ).toMatchObject({
      totalTokens: 262_144,
      totalLabel: "262K",
      usedTokens: 41_943,
      usedLabel: "41.9K",
      remainingTokens: 220_201,
      remainingLabel: "220.2K",
      usageScope: "thread",
    });
  });
});
