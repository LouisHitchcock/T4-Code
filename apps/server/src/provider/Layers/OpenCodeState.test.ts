import { describe, expect, it } from "vitest";

import {
  applyModelsDevContextWindows,
  mergeOpenCodeMcpServerStatuses,
  parseOpenCodeMcpAuthListOutput,
  parseOpenCodeMcpListOutput,
  parseOpenCodeModelsOutput,
} from "./OpenCodeState";

describe("parseOpenCodeModelsOutput", () => {
  it("parses provider-scoped model ids from OpenCode CLI output", () => {
    expect(
      parseOpenCodeModelsOutput(`
        minimax-coding-plan/MiniMax-M2.7
        openai/gpt-5.1-codex
      `),
    ).toEqual([
      {
        slug: "minimax-coding-plan/MiniMax-M2.7",
        providerId: "minimax-coding-plan",
        modelId: "MiniMax-M2.7",
      },
      {
        slug: "openai/gpt-5.1-codex",
        providerId: "openai",
        modelId: "gpt-5.1-codex",
      },
    ]);
  });
});

describe("applyModelsDevContextWindows", () => {
  it("enriches provider-scoped OpenCode models with models.dev context limits", () => {
    const models = [
      {
        slug: "minimax-coding-plan/MiniMax-M2.7",
        providerId: "minimax-coding-plan",
        modelId: "MiniMax-M2.7",
      },
      {
        slug: "openai/gpt-5.1-codex",
        providerId: "openai",
        modelId: "gpt-5.1-codex",
      },
    ];

    const catalog = {
      "minimax-coding-plan": {
        models: {
          "MiniMax-M2.7": {
            limit: {
              context: 204_800,
            },
          },
        },
      },
      openai: {
        models: {
          "gpt-5.1-codex": {
            limit: {
              context: 400_000,
            },
          },
        },
      },
    };

    expect(applyModelsDevContextWindows(models, catalog)).toEqual([
      {
        slug: "minimax-coding-plan/MiniMax-M2.7",
        providerId: "minimax-coding-plan",
        modelId: "MiniMax-M2.7",
        contextWindowTokens: 204_800,
      },
      {
        slug: "openai/gpt-5.1-codex",
        providerId: "openai",
        modelId: "gpt-5.1-codex",
        contextWindowTokens: 400_000,
      },
    ]);
  });

  it("matches models.dev entries case-insensitively when provider output casing drifts", () => {
    const models = [
      {
        slug: "minimax-coding-plan/minimax-m2.7",
        providerId: "minimax-coding-plan",
        modelId: "minimax-m2.7",
      },
    ];

    const catalog = {
      "minimax-coding-plan": {
        models: {
          "MiniMax-M2.7": {
            limit: {
              context: 204_800,
            },
          },
        },
      },
    };

    expect(applyModelsDevContextWindows(models, catalog)).toEqual([
      {
        slug: "minimax-coding-plan/minimax-m2.7",
        providerId: "minimax-coding-plan",
        modelId: "minimax-m2.7",
        contextWindowTokens: 204_800,
      },
    ]);
  });
});

describe("parseOpenCodeMcpListOutput", () => {
  it("parses connected, failed, disabled, and auth-gated MCP server entries from OpenCode CLI output", () => {
    expect(
      parseOpenCodeMcpListOutput(`
        ┌  MCP Servers
        │
        ●  ✓ github connected
        │      sh -c GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) npx -y @modelcontextprotocol/server-github
        │
        ●  ✗ paper failed
        │      SSE error: Unable to connect. Is the computer able to access the url?
        │      http://127.0.0.1:29979/mcp
        │
        ●  ○ context7 disabled
        │      https://mcp.context7.com/mcp
        │
        ●  ⚠ sentry needs authentication
        │      https://mcp.sentry.dev/mcp
        │
        ●  ✗ linear needs client registration
        │      Missing client metadata
        │      https://mcp.linear.app/sse
        │
        └  5 server(s)
      `),
    ).toEqual([
      {
        name: "github",
        enabled: true,
        state: "enabled",
        authStatus: "unsupported",
        connectionStatus: "connected",
        target:
          "sh -c GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) npx -y @modelcontextprotocol/server-github",
      },
      {
        name: "paper",
        enabled: true,
        state: "enabled",
        authStatus: "unsupported",
        connectionStatus: "failed",
        message: "SSE error: Unable to connect. Is the computer able to access the url?",
        target: "http://127.0.0.1:29979/mcp",
      },
      {
        name: "context7",
        enabled: false,
        state: "disabled",
        authStatus: "unknown",
        connectionStatus: "unknown",
        target: "https://mcp.context7.com/mcp",
      },
      {
        name: "sentry",
        enabled: true,
        state: "enabled",
        authStatus: "not_logged_in",
        connectionStatus: "unknown",
        message: "Needs authentication.",
        target: "https://mcp.sentry.dev/mcp",
      },
      {
        name: "linear",
        enabled: true,
        state: "enabled",
        authStatus: "unknown",
        connectionStatus: "failed",
        message: "Missing client metadata",
        target: "https://mcp.linear.app/sse",
      },
    ]);
  });
});

describe("parseOpenCodeMcpAuthListOutput", () => {
  it("parses OAuth-capable MCP auth status entries from OpenCode CLI output", () => {
    expect(
      parseOpenCodeMcpAuthListOutput(`
        ┌  MCP OAuth Status
        │
        ●  ✗ context7 not authenticated
        │      https://mcp.context7.com/mcp
        │
        ●  ✓ sentry authenticated
        │      https://mcp.sentry.dev/mcp
        │
        └  2 OAuth-capable server(s)
      `),
    ).toEqual([
      {
        name: "context7",
        authStatus: "not_logged_in",
        target: "https://mcp.context7.com/mcp",
      },
      {
        name: "sentry",
        authStatus: "o_auth",
        target: "https://mcp.sentry.dev/mcp",
      },
    ]);
  });
});

describe("mergeOpenCodeMcpServerStatuses", () => {
  it("merges runtime MCP status with OAuth auth state for OpenCode", () => {
    expect(
      mergeOpenCodeMcpServerStatuses({
        runtimeServers: [
          {
            name: "context7",
            enabled: true,
            state: "enabled",
            authStatus: "unsupported",
            connectionStatus: "connected",
            target: "https://mcp.context7.com/mcp",
          },
          {
            name: "paper",
            enabled: true,
            state: "enabled",
            authStatus: "unsupported",
            connectionStatus: "failed",
            target: "http://127.0.0.1:29979/mcp",
            message: "SSE error: Unable to connect.",
          },
          {
            name: "disabled-server",
            enabled: false,
            state: "disabled",
            authStatus: "unknown",
            connectionStatus: "unknown",
            target: "https://mcp.disabled.dev/mcp",
          },
        ],
        authServers: [
          {
            name: "context7",
            authStatus: "not_logged_in",
            target: "https://mcp.context7.com/mcp",
          },
        ],
      }),
    ).toEqual([
      {
        name: "context7",
        enabled: true,
        state: "enabled",
        authStatus: "not_logged_in",
        toolCount: 0,
        resourceCount: 0,
        resourceTemplateCount: 0,
        connectionStatus: "connected",
        target: "https://mcp.context7.com/mcp",
      },
      {
        name: "disabled-server",
        enabled: false,
        state: "disabled",
        authStatus: "unknown",
        toolCount: 0,
        resourceCount: 0,
        resourceTemplateCount: 0,
        connectionStatus: "unknown",
        target: "https://mcp.disabled.dev/mcp",
      },
      {
        name: "paper",
        enabled: true,
        state: "enabled",
        authStatus: "unsupported",
        toolCount: 0,
        resourceCount: 0,
        resourceTemplateCount: 0,
        connectionStatus: "failed",
        target: "http://127.0.0.1:29979/mcp",
        message: "SSE error: Unable to connect.",
      },
    ]);
  });
});
