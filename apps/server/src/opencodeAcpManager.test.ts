import { OPENCODE_DEFAULT_MODEL, ThreadId } from "@draft/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  OpenCodeAcpManager,
  buildOpenCodeClientCapabilities,
  buildOpenCodeToolSchemaRecoveryPrompt,
  buildOpenCodeCliArgs,
  buildOpenCodeCliEnv,
  classifyOpenCodeToolInvocationFailure,
  isOpenCodeClientToolBridgeEnabled,
  isOpenCodeDefaultModel,
  isOpenCodeModelAvailable,
  normalizeOpenCodeStartErrorMessage,
  readAvailableOpenCodeModelIds,
  shouldRetryOpenCodeToolInvocationFailure,
  shouldRetryOpenCodeToolSchemaFailure,
} from "./opencodeAcpManager";

describe("opencodeAcpManager model availability", () => {
  it("reads ACP-advertised model ids", () => {
    expect(
      readAvailableOpenCodeModelIds({
        currentModelId: "z-ai/glm-4.5",
        availableModels: [
          { modelId: "z-ai/glm-4.5", name: "GLM 4.5" },
          { modelId: "minimax/MiniMax-M2.7", name: "MiniMax M2.7" },
        ],
      }),
    ).toEqual(["z-ai/glm-4.5", "minimax/MiniMax-M2.7"]);
  });

  it("treats requested models as unavailable when ACP advertises a different model set", () => {
    expect(
      isOpenCodeModelAvailable(
        {
          currentModelId: "z-ai/glm-4.5",
          availableModels: [{ modelId: "z-ai/glm-4.5", name: "GLM 4.5" }],
        },
        "minimax/MiniMax-M2.7",
      ),
    ).toBe(false);
  });

  it("allows requested models when ACP has not advertised any model set yet", () => {
    expect(isOpenCodeModelAvailable(null, "z-ai/glm-4.5")).toBe(true);
  });

  it("detects the OpenCode default sentinel", () => {
    expect(isOpenCodeDefaultModel(OPENCODE_DEFAULT_MODEL)).toBe(true);
    expect(isOpenCodeDefaultModel("z-ai/glm-4.5")).toBe(false);
  });
});

describe("opencodeAcpManager startup", () => {
  it("builds ACP startup args with the requested working directory", () => {
    expect(buildOpenCodeCliArgs({ cwd: "/tmp/project" })).toEqual(["acp", "--cwd", "/tmp/project"]);
  });

  it("injects OPENROUTER_API_KEY into the OpenCode subprocess env when provided", () => {
    expect(
      buildOpenCodeCliEnv({
        runtimeMode: "full-access",
        openRouterApiKey: "sk-or-secret",
        baseEnv: {
          PATH: "/usr/bin",
          HOME: "/tmp/home",
        },
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      OPENROUTER_API_KEY: "sk-or-secret",
    });
  });

  it("preserves unrelated env vars for full-access sessions", () => {
    expect(
      buildOpenCodeCliEnv({
        runtimeMode: "full-access",
        baseEnv: {
          PATH: "/usr/bin",
          HOME: "/tmp/home",
        },
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
    });
  });

  it("merges approval-required permissions into OPENCODE_CONFIG_CONTENT", () => {
    expect(
      buildOpenCodeCliEnv({
        runtimeMode: "approval-required",
        baseEnv: {
          PATH: "/usr/bin",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            permission: { read: "allow" },
            model: "z-ai/glm-4.5",
          }),
        },
      }),
    ).toEqual({
      PATH: "/usr/bin",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { read: "allow", edit: "ask", bash: "ask" },
        model: "z-ai/glm-4.5",
      }),
    });
  });

  it("merges OpenCode config overrides and env overrides for local runtimes", () => {
    const env = buildOpenCodeCliEnv({
      runtimeMode: "approval-required",
      configContent: JSON.stringify({
        permission: {
          read: "allow",
          edit: "allow",
        },
        provider: {
          ollama: {
            options: {
              baseURL: "http://localhost:11434/v1",
            },
          },
        },
      }),
      envOverrides: {
        OLLAMA_HOST: "http://localhost:11434",
        " invalid-key ": "ignored",
      },
      baseEnv: {
        PATH: "/usr/bin",
      },
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OLLAMA_HOST).toBe("http://localhost:11434");
    expect(env.OPENCODE_CONFIG_CONTENT).toBeDefined();
    expect(JSON.parse(String(env.OPENCODE_CONFIG_CONTENT))).toEqual({
      permission: { read: "allow", edit: "ask", bash: "ask" },
      provider: {
        ollama: {
          options: {
            baseURL: "http://localhost:11434/v1",
          },
        },
      },
    });
  });
});

describe("opencodeAcpManager client bridge", () => {
  it("enables the ACP client bridge only when explicitly requested", () => {
    expect(
      isOpenCodeClientToolBridgeEnabled({
        opencode: {
          useClientToolBridge: true,
        },
      }),
    ).toBe(true);
    expect(isOpenCodeClientToolBridgeEnabled(undefined)).toBe(false);
    expect(
      isOpenCodeClientToolBridgeEnabled({
        opencode: {
          useClientToolBridge: false,
        },
      }),
    ).toBe(false);
  });

  it("advertises fs and terminal capabilities only when bridge is enabled", () => {
    expect(buildOpenCodeClientCapabilities({ useClientToolBridge: false })).toEqual({});
    expect(buildOpenCodeClientCapabilities({ useClientToolBridge: true })).toEqual({
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
    });
  });
});

describe("opencodeAcpManager errors", () => {
  it("rewrites missing OPENROUTER_API_KEY errors with actionable guidance", () => {
    expect(
      normalizeOpenCodeStartErrorMessage("Missing environment variable: 'OPENROUTER_API_KEY'."),
    ).toBe(
      "OpenCode provider config requires OPENROUTER_API_KEY. Add an OpenRouter API key in Draft Settings or export OPENROUTER_API_KEY before starting Draft.",
    );
  });

  it("normalizes authentication errors into a login message", () => {
    expect(normalizeOpenCodeStartErrorMessage("Authentication required")).toBe(
      "OpenCode requires authentication. Run `opencode auth login` and try again.",
    );
  });

  it("preserves unrelated startup errors", () => {
    expect(
      normalizeOpenCodeStartErrorMessage("OpenCode ACP initialize timed out after 10000ms."),
    ).toBe("OpenCode ACP initialize timed out after 10000ms.");
  });
});
describe("opencodeAcpManager tool schema recovery", () => {
  it("detects retryable task/todo schema argument failures", () => {
    expect(
      shouldRetryOpenCodeToolSchemaFailure(
        "The task tool was called with invalid arguments: SchemaError(Missing key: todos)",
      ),
    ).toBe(true);
  });
  it("detects retryable missing-skill failures", () => {
    expect(
      shouldRetryOpenCodeToolInvocationFailure(
        "Skill 'python-animation' not found. Available skills: none",
      ),
    ).toBe(true);
  });

  it("classifies unavailable-tool failures for retry suppression decisions", () => {
    expect(
      classifyOpenCodeToolInvocationFailure(
        "Skill 'python-animation' not found. Available skills: none",
      ),
    ).toBe("unavailable");
    expect(
      classifyOpenCodeToolInvocationFailure(
        "The task tool was called with invalid arguments: SchemaError(Missing key: todos)",
      ),
    ).toBe("schema");
  });

  it("ignores unrelated runtime failures", () => {
    expect(
      shouldRetryOpenCodeToolSchemaFailure("OpenCode ACP initialize timed out after 10000ms."),
    ).toBe(false);
  });

  it("builds a corrective recovery prompt for retryable tool-schema errors", () => {
    const prompt = buildOpenCodeToolSchemaRecoveryPrompt({
      rawMessage: "The task tool was called with invalid arguments: SchemaError(Missing key: todos)",
      originalUserRequest: "Build a tkinter DVD bounce animation in bounce.py and run it.",
    });
    expect(prompt).toContain("For todo tracking in OpenCode, use only: todowrite.");
    expect(prompt).toContain("<original_user_request>");
    expect(prompt).toContain("Build a tkinter DVD bounce animation in bounce.py and run it.");
    expect(prompt).toContain(
      "Do not substitute tool-description examples (for example dark mode or React optimization templates) in place of the actual user request.",
    );
    expect(prompt).toContain(
      "Do not call `skill` unless the requested skill exists; if available skills are none, continue without `skill`.",
    );
    expect(prompt).toContain(
      "todowrite requires input like {\"todos\":[{\"content\":\"...\",\"status\":\"pending|in_progress|completed|cancelled\",\"priority\":\"high|medium|low\"}]}.",
    );
    expect(prompt).toContain(
      "Use task only for subagent delegation; task requires description, prompt, and subagent_type (optional task_id).",
    );
    expect(prompt).toContain("Detected tool failure kind: schema.");
    expect(prompt).toContain(
      "Translate Draft/Warp tool aliases to OpenCode built-ins before retrying:",
    );
    expect(prompt).toContain("- read_files -> read");
    expect(prompt).toContain(
      "Use only these OpenCode built-ins: bash, read, write, edit, glob, list, grep, apply_patch, webfetch, websearch, todoread, todowrite, task, question, skill.",
    );
    expect(prompt).toContain("- for write/edit payloads, prefer filePath when required by schema");
    expect(prompt).toContain("- if the model emits XML-style tool syntax");
  });
});

describe("opencodeAcpManager sendTurn retries", () => {
  it("fails fast when an explicitly selected non-default model is unavailable", async () => {
    const manager = new OpenCodeAcpManager();
    const threadId = ThreadId.makeUnsafe("thread-opencode-unavailable-model");
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" } as any);
    const context = {
      session: {
        provider: "opencode",
        status: "ready",
        runtimeMode: "approval-required",
        threadId,
        model: "z-ai/glm-4.5",
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
        activeTurnId: undefined,
      },
      child: {} as any,
      connection: {
        prompt,
        cancel: vi.fn(),
      },
      acpSessionId: "acp-session-1",
      models: {
        currentModelId: "z-ai/glm-4.5",
        availableModels: [{ modelId: "z-ai/glm-4.5", name: "GLM 4.5" }],
      },
      promptTimeoutMs: 120_000,
      pendingApprovals: new Map(),
      toolSnapshots: new Map(),
      currentTurnId: undefined,
      turnInFlight: false,
      stopping: false,
      lastStderrLine: undefined,
      lastToolSchemaFailure: undefined,
    };
    (manager as any).sessions.set(threadId, context);

    await expect(
      manager.sendTurn({
        threadId,
        input: "Continue implementing the requested task.",
        model: "ollama/qwen2.5-coder:latest",
      }),
    ).rejects.toThrow("OpenCode does not expose the requested model");
    expect(prompt).not.toHaveBeenCalled();
  });
  it("retries once when streamed tool_call_update failure indicates schema errors", async () => {
    const manager = new OpenCodeAcpManager();
    const threadId = ThreadId.makeUnsafe("thread-opencode-streamed-schema-retry");
    let context: any;

    const prompt = vi
      .fn()
      .mockImplementationOnce(async () => {
        (manager as any).handleSessionUpdate(
          context,
          {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-call-1",
              status: "failed",
              title: "task",
              content: [
                {
                  type: "text",
                  text: "The task tool was called with invalid arguments: SchemaError(Missing key: todos)",
                },
              ],
            },
          } as any,
        );
        return { stopReason: "end_turn" } as any;
      })
      .mockResolvedValueOnce({ stopReason: "end_turn" } as any);

    context = {
      session: {
        provider: "opencode",
        status: "ready",
        runtimeMode: "approval-required",
        threadId,
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
        activeTurnId: undefined,
      },
      child: {} as any,
      connection: {
        prompt,
        cancel: vi.fn(),
      },
      acpSessionId: "acp-session-1",
      models: null,
      promptTimeoutMs: 120_000,
      pendingApprovals: new Map(),
      toolSnapshots: new Map(),
      currentTurnId: undefined,
      turnInFlight: false,
      stopping: false,
      lastStderrLine: undefined,
      lastToolSchemaFailure: undefined,
    };

    (manager as any).sessions.set(threadId, context);
    await manager.sendTurn({ threadId, input: "Continue implementing the requested task." });

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(context.session.status).toBe("ready");
    expect(context.session.lastError).toBeUndefined();
  });

  it("does not retry when streamed tool_call_update failure is unrelated to schema args", async () => {
    const manager = new OpenCodeAcpManager();
    const threadId = ThreadId.makeUnsafe("thread-opencode-streamed-nonschema-failure");
    let context: any;

    const prompt = vi.fn().mockImplementationOnce(async () => {
      (manager as any).handleSessionUpdate(
        context,
        {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-call-1",
            status: "failed",
            title: "bash",
            content: [
              {
                type: "text",
                text: "Command exited with code 1",
              },
            ],
          },
        } as any,
      );
      return { stopReason: "end_turn" } as any;
    });

    context = {
      session: {
        provider: "opencode",
        status: "ready",
        runtimeMode: "approval-required",
        threadId,
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
        activeTurnId: undefined,
      },
      child: {} as any,
      connection: {
        prompt,
        cancel: vi.fn(),
      },
      acpSessionId: "acp-session-1",
      models: null,
      promptTimeoutMs: 120_000,
      pendingApprovals: new Map(),
      toolSnapshots: new Map(),
      currentTurnId: undefined,
      turnInFlight: false,
      stopping: false,
      lastStderrLine: undefined,
      lastToolSchemaFailure: undefined,
    };

    (manager as any).sessions.set(threadId, context);
    await manager.sendTurn({ threadId, input: "Continue implementing the requested task." });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(context.session.status).toBe("ready");
  });

  it("suppresses repeated unavailable-tool retries within the same turn", async () => {
    const manager = new OpenCodeAcpManager();
    const threadId = ThreadId.makeUnsafe("thread-opencode-streamed-unavailable-retry-suppressed");
    const events: unknown[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    let context: any;

    const prompt = vi
      .fn()
      .mockImplementationOnce(async () => {
        (manager as any).handleSessionUpdate(
          context,
          {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-call-1",
              status: "failed",
              title: "skill",
              content: [
                {
                  type: "text",
                  text: "Skill 'file-creator' not found. Available skills: none",
                },
              ],
            },
          } as any,
        );
        return { stopReason: "end_turn" } as any;
      })
      .mockImplementationOnce(async () => {
        (manager as any).handleSessionUpdate(
          context,
          {
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-call-2",
              status: "failed",
              title: "skill",
              content: [
                {
                  type: "text",
                  text: "Skill 'file-creator' not found. Available skills: none",
                },
              ],
            },
          } as any,
        );
        throw new Error("Model tried to call unavailable tool: skill");
      });

    context = {
      session: {
        provider: "opencode",
        status: "ready",
        runtimeMode: "approval-required",
        threadId,
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
        activeTurnId: undefined,
      },
      child: {} as any,
      connection: {
        prompt,
        cancel: vi.fn(),
      },
      acpSessionId: "acp-session-1",
      models: null,
      promptTimeoutMs: 120_000,
      pendingApprovals: new Map(),
      toolSnapshots: new Map(),
      currentTurnId: undefined,
      turnInFlight: false,
      stopping: false,
      lastStderrLine: undefined,
      lastToolSchemaFailure: undefined,
    };

    (manager as any).sessions.set(threadId, context);
    await expect(
      manager.sendTurn({ threadId, input: "Continue implementing the requested task." }),
    ).rejects.toThrow("Model tried to call unavailable tool: skill");

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(context.session.status).toBe("error");
    expect(
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "runtime.warning" &&
          "payload" in event &&
          typeof (event as any).payload?.message === "string" &&
          (event as any).payload.message.includes("no further retries"),
      ),
    ).toBe(true);
  });

  it("marks prompt watchdog timeouts as failed turns but keeps the session recoverable", async () => {
    const manager = new OpenCodeAcpManager();
    const threadId = ThreadId.makeUnsafe("thread-opencode-prompt-timeout");
    const events: unknown[] = [];
    manager.on("event", (event) => {
      events.push(event);
    });
    const prompt = vi.fn(() => new Promise<never>(() => undefined));
    const cancel = vi.fn().mockResolvedValue(undefined);
    const context = {
      session: {
        provider: "opencode",
        status: "ready",
        runtimeMode: "approval-required",
        threadId,
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
        activeTurnId: undefined,
      },
      child: {} as any,
      connection: {
        prompt,
        cancel,
      },
      acpSessionId: "acp-session-timeout",
      models: null,
      promptTimeoutMs: 5,
      pendingApprovals: new Map(),
      toolSnapshots: new Map(),
      currentTurnId: undefined,
      turnInFlight: false,
      stopping: false,
      lastStderrLine: undefined,
      lastToolSchemaFailure: undefined,
    };
    (manager as any).sessions.set(threadId, context);

    await expect(
      manager.sendTurn({
        threadId,
        input: "Run a long operation that should timeout.",
      }),
    ).rejects.toThrow("timed out");

    expect(cancel).toHaveBeenCalledWith({ sessionId: "acp-session-timeout" });
    expect(context.session.status).toBe("ready");
    expect(
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "runtime.warning",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "turn.completed" &&
          "payload" in event &&
          (event as any).payload?.state === "failed",
      ),
    ).toBe(true);
  });
});

describe("opencodeAcpManager lifecycle", () => {
  it("treats starting sessions as active for hasSession checks", async () => {
    const manager = new OpenCodeAcpManager();
    const threadId = ThreadId.makeUnsafe("thread-opencode-starting");

    (manager as any).startingSessions.set(threadId, {
      session: {
        provider: "opencode",
        status: "connecting",
        runtimeMode: "approval-required",
        threadId,
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
      },
    });

    await expect(manager.hasSession(threadId)).resolves.toBe(true);
  });

  it("stops sessions that are still starting", async () => {
    const manager = new OpenCodeAcpManager();
    const threadId = ThreadId.makeUnsafe("thread-opencode-stop");
    const context = {
      session: {
        provider: "opencode",
        status: "connecting",
        runtimeMode: "approval-required",
        threadId,
        createdAt: "2026-03-19T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
      },
    };
    (manager as any).startingSessions.set(threadId, context);
    const disposeContext = vi.spyOn(manager as any, "disposeContext").mockResolvedValue(undefined);

    await manager.stopSession(threadId);

    expect(disposeContext).toHaveBeenCalledWith(context);
  });
});
