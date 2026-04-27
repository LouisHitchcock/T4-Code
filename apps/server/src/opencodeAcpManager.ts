import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import * as acp from "@agentclientprotocol/sdk";
import {
  ApprovalRequestId,
  EventId,
  OPENCODE_DEFAULT_MODEL,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderTurnStartResult,
} from "@draft/contracts";

import {
  createPermissionOutcome,
  extractTextFromContentBlock,
  killChildTree,
  mapPlanEntryStatus,
  mapToolCallStatus,
  mapToolKindToItemType,
  mapToolKindToRequestType,
  permissionDecisionFromOutcome,
  readResumeSessionId,
  summarizeToolContent,
  toMessage,
  type AcpPermissionRequestType,
} from "./provider/acpRuntimeShared.ts";

interface PendingApprovalRequest {
  readonly requestId: ApprovalRequestId;
  readonly toolCallId: string;
  readonly turnId: TurnId | undefined;
  readonly requestType: AcpPermissionRequestType;
  readonly options: ReadonlyArray<acp.PermissionOption>;
  readonly resolve: (response: acp.RequestPermissionResponse) => void;
}

export function isOpenCodeClientToolBridgeEnabled(
  providerOptions: ProviderSessionStartInput["providerOptions"] | undefined,
): boolean {
  return providerOptions?.opencode?.useClientToolBridge === true;
}

export function buildOpenCodeClientCapabilities(input: {
  readonly useClientToolBridge: boolean;
}): acp.ClientCapabilities {
  return input.useClientToolBridge ? OPENCODE_CLIENT_TOOL_BRIDGE_CAPABILITIES : {};
}

class TimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(input: { readonly label: string; readonly timeoutMs: number }) {
    super(`${input.label} timed out after ${input.timeoutMs}ms.`);
    this.name = "TimeoutError";
    this.label = input.label;
    this.timeoutMs = input.timeoutMs;
  }
}

function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

type OpenCodePromptPhase = "primary" | "retry";

class OpenCodePromptTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly phase: OpenCodePromptPhase;

  constructor(input: {
    readonly message: string;
    readonly timeoutMs: number;
    readonly phase: OpenCodePromptPhase;
    readonly cause: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "OpenCodePromptTimeoutError";
    this.timeoutMs = input.timeoutMs;
    this.phase = input.phase;
  }
}

function isOpenCodePromptTimeoutError(error: unknown): error is OpenCodePromptTimeoutError {
  return error instanceof OpenCodePromptTimeoutError;
}

interface ToolSnapshot {
  readonly kind: acp.ToolKind | null;
  readonly title: string;
}
type OpenCodeToolInvocationFailureKind = "schema" | "unavailable";

interface OpenCodeToolSchemaFailure {
  readonly kind: OpenCodeToolInvocationFailureKind;
  readonly message: string;
}
interface OpenCodeBridgeTerminalState {
  readonly terminalId: string;
  readonly child: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  exitStatus: acp.TerminalExitStatus | undefined;
  readonly waitForExit: Promise<acp.TerminalExitStatus>;
  readonly resolveWaitForExit: (status: acp.TerminalExitStatus) => void;
}

interface OpenCodeSessionContext {
  session: ProviderSession;
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientSideConnection;
  acpSessionId: string;
  models: acp.SessionModelState | null;
  promptTimeoutMs: number;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  toolSnapshots: Map<string, ToolSnapshot>;
  currentTurnId: TurnId | undefined;
  turnInFlight: boolean;
  stopping: boolean;
  bridgeEnabled: boolean;
  bridgeTerminals: Map<string, OpenCodeBridgeTerminalState>;
  nextBridgeTerminalOrdinal: number;
  lastStderrLine?: string;
  lastToolSchemaFailure: OpenCodeToolSchemaFailure | undefined;
}

export interface OpenCodeAppServerStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "opencode";
  readonly cwd?: string;
  readonly model?: string;
  readonly resumeCursor?: unknown;
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
  readonly runtimeMode: ProviderSession["runtimeMode"];
}

export interface OpenCodeThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface OpenCodeThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<OpenCodeThreadTurnSnapshot>;
}

export interface OpenCodeAcpManagerEvents {
  event: [event: ProviderRuntimeEvent];
}

const OPENCODE_ACP_INITIALIZE_TIMEOUT_MS = 10_000;
const OPENCODE_ACP_SESSION_START_TIMEOUT_MS = 10_000;
const OPENCODE_DEFAULT_PROMPT_TIMEOUT_MS = 300_000;
const OPENCODE_MIN_PROMPT_TIMEOUT_MS = 1;
const OPENCODE_MAX_PROMPT_TIMEOUT_MS = 900_000;
const OPENROUTER_ENV_KEY = "OPENROUTER_API_KEY";
const OPENCODE_TOOL_SCHEMA_ERROR_PATTERN = /(?:invalid arguments|schemaerror|missing key)/i;
const OPENCODE_TOOL_SCHEMA_CONTEXT_PATTERN = /(?:\btool\b|\btask\b|\btodolist\b|\btodo\b)/i;
const OPENCODE_UNAVAILABLE_TOOL_ERROR_PATTERN =
  /(?:\bskill\b.*\bnot found\b|available skills:\s*none|unavailable tool|model tried to call unavailable tool|unknown tool)/i;
const OPENCODE_UNAVAILABLE_TOOL_CONTEXT_PATTERN = /(?:\btool\b|\bskill\b|\bavailable skills\b)/i;
const OPENCODE_ENV_OVERRIDE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const OPENCODE_BRIDGE_MAX_TERMINAL_OUTPUT_CHARS = 200_000;
const OPENCODE_CLIENT_TOOL_BRIDGE_CAPABILITIES = {
  fs: {
    readTextFile: true,
    writeTextFile: true,
  },
  terminal: true,
} satisfies acp.ClientCapabilities;
const OPENCODE_TOOL_ALIAS_GUIDANCE_LINES = [
  "Translate Draft/Warp tool aliases to OpenCode built-ins before retrying:",
  "- read_files -> read",
  "- file_glob -> glob (or list for directory listings)",
  "- grep / ripgrep -> grep",
  "- run_shell_command / terminal.exec -> bash",
  "- ask_user_question -> question",
  "- create_todo_list / add_todos / mark_todo_as_done / remove_todos -> todowrite",
  "- read_todos -> todoread",
  "- read_skill -> skill only when skills are available",
  "- for write/edit payloads, prefer filePath when required by schema (write {\"filePath\":\"notes.txt\",\"content\":\"hello\"}, edit {\"filePath\":\"src/main.cpp\",\"oldString\":\"foo\",\"newString\":\"bar\"})",
  "- if the model emits XML-style tool syntax (for example <function=bash> <parameter=command>...</parameter>), translate it to a real tool call like bash({\"command\":\"...\"}) and never echo XML to the user",
] as const;
const OPENCODE_BUILTIN_ALLOWLIST_LINE =
  "Use only these OpenCode built-ins: bash, read, write, edit, glob, list, grep, apply_patch, webfetch, websearch, todoread, todowrite, task, question, skill.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isOpenCodeDefaultModel(model: string | null | undefined): boolean {
  return model?.trim() === OPENCODE_DEFAULT_MODEL;
}

function normalizeRequestedOpenCodeModel(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || isOpenCodeDefaultModel(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function readAvailableOpenCodeModelIds(
  models: acp.SessionModelState | null | undefined,
): ReadonlyArray<string> {
  return models?.availableModels.map((entry) => entry.modelId) ?? [];
}

export function isOpenCodeModelAvailable(
  models: acp.SessionModelState | null | undefined,
  model: string,
): boolean {
  const availableModelIds = readAvailableOpenCodeModelIds(models);
  return availableModelIds.length === 0 || availableModelIds.includes(model);
}

function buildOpenCodeUnavailableModelMessage(input: {
  readonly model: string;
  readonly availableModelIds: ReadonlyArray<string>;
}): string {
  return `OpenCode does not expose the requested model '${input.model}' for this session. Available models: ${input.availableModelIds.join(", ")}. Select one of the available models or refresh your OpenCode/Ollama model configuration.`;
}

export function buildOpenCodeCliArgs(input: { readonly cwd: string }): ReadonlyArray<string> {
  return ["acp", "--cwd", input.cwd];
}

function normalizeOpenCodePromptTimeoutMs(value: number | undefined): number {
  const normalizedValue =
    typeof value === "number" && Number.isInteger(value)
      ? value
      : OPENCODE_DEFAULT_PROMPT_TIMEOUT_MS;
  return Math.min(
    OPENCODE_MAX_PROMPT_TIMEOUT_MS,
    Math.max(OPENCODE_MIN_PROMPT_TIMEOUT_MS, normalizedValue),
  );
}

function parseOpenCodeConfigContent(raw: string | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildOpenCodeRuntimeConfig(
  runtimeMode: ProviderSession["runtimeMode"],
): Record<string, unknown> {
  if (runtimeMode === "full-access") {
    return {};
  }

  return {
    permission: {
      edit: "ask",
      bash: "ask",
    },
  };
}

function mergeOpenCodeConfig(
  baseConfig: Record<string, unknown>,
  overrideConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(overrideConfig).length === 0) {
    return baseConfig;
  }

  const merged = { ...baseConfig, ...overrideConfig };
  const basePermission = isRecord(baseConfig.permission) ? baseConfig.permission : undefined;
  const overridePermission = isRecord(overrideConfig.permission)
    ? overrideConfig.permission
    : undefined;
  if (basePermission || overridePermission) {
    merged.permission = {
      ...basePermission,
      ...overridePermission,
    };
  }
  return merged;
}

export function buildOpenCodeCliEnv(input: {
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly openRouterApiKey?: string;
  readonly configContent?: string;
  readonly envOverrides?: Record<string, string>;
  readonly baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env = { ...(input.baseEnv ?? process.env) };
  const openRouterApiKey = input.openRouterApiKey?.trim();
  if (openRouterApiKey) {
    env[OPENROUTER_ENV_KEY] = openRouterApiKey;
  }
  const envOverrides = Object.fromEntries(
    Object.entries(input.envOverrides ?? {})
      .map(([rawKey, rawValue]) => [rawKey.trim().toUpperCase(), rawValue.trim()] as const)
      .filter(
        ([key, value]) =>
          key.length > 0 &&
          key.length <= 128 &&
          value.length > 0 &&
          value.length <= 4_096 &&
          OPENCODE_ENV_OVERRIDE_KEY_PATTERN.test(key),
      )
      .slice(0, 64),
  );
  for (const [key, value] of Object.entries(envOverrides)) {
    env[key] = value;
  }

  const overrideConfig = parseOpenCodeConfigContent(input.configContent);

  const runtimeConfig = buildOpenCodeRuntimeConfig(input.runtimeMode);
  if (Object.keys(runtimeConfig).length === 0 && Object.keys(overrideConfig).length === 0) {
    return env;
  }

  const mergedConfig = mergeOpenCodeConfig(
    mergeOpenCodeConfig(parseOpenCodeConfigContent(env.OPENCODE_CONFIG_CONTENT), overrideConfig),
    runtimeConfig,
  );
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(mergedConfig);
  return env;
}

export function normalizeOpenCodeStartErrorMessage(rawMessage: string): string {
  if (/missing environment variable:\s*['"]?OPENROUTER_API_KEY['"]?/i.test(rawMessage)) {
    return "OpenCode provider config requires OPENROUTER_API_KEY. Add an OpenRouter API key in Draft Settings or export OPENROUTER_API_KEY before starting Draft.";
  }

  if (
    /auth[_ ]required|authentication required|not logged in|run `?opencode auth login`?|loadapi key error|api key/i.test(
      rawMessage,
    )
  ) {
    return "OpenCode requires authentication. Run `opencode auth login` and try again.";
  }

  return rawMessage;
}

export function classifyOpenCodeToolInvocationFailure(
  rawMessage: string,
): OpenCodeToolInvocationFailureKind | null {
  const message = rawMessage.trim();
  if (message.length === 0) {
    return null;
  }
  if (
    OPENCODE_TOOL_SCHEMA_ERROR_PATTERN.test(message) &&
    OPENCODE_TOOL_SCHEMA_CONTEXT_PATTERN.test(message)
  ) {
    return "schema";
  }
  if (
    OPENCODE_UNAVAILABLE_TOOL_ERROR_PATTERN.test(message) &&
    OPENCODE_UNAVAILABLE_TOOL_CONTEXT_PATTERN.test(message)
  ) {
    return "unavailable";
  }
  return null;
}
export function shouldRetryOpenCodeToolSchemaFailure(rawMessage: string): boolean {
  return classifyOpenCodeToolInvocationFailure(rawMessage) === "schema";
}
export function shouldRetryOpenCodeToolInvocationFailure(rawMessage: string): boolean {
  return classifyOpenCodeToolInvocationFailure(rawMessage) !== null;
}
export function buildOpenCodeToolSchemaRecoveryPrompt(input: {
  readonly rawMessage: string;
  readonly originalUserRequest?: string;
}): string | undefined {
  const message = input.rawMessage.trim();
  const failureKind = classifyOpenCodeToolInvocationFailure(message);
  if (!failureKind) {
    return undefined;
  }
  const normalizedError = message.replace(/\s+/g, " ").slice(0, 320);
  const normalizedUserRequest = input.originalUserRequest?.trim();
  return [
    "Continue the exact same in-progress user request.",
    `The previous tool call failed: ${normalizedError}`,
    "Retry immediately with corrected tool calls; do not stop to apologize.",
    ...(normalizedUserRequest && normalizedUserRequest.length > 0
      ? [
          "Original user request (do not replace it with tool-description examples):",
          "<original_user_request>",
          normalizedUserRequest.slice(0, 4_000),
          "</original_user_request>",
        ]
      : []),
    `Detected tool failure kind: ${failureKind}.`,
    "Do not substitute tool-description examples (for example dark mode or React optimization templates) in place of the actual user request.",
    "Do not call `skill` unless the requested skill exists; if available skills are none, continue without `skill`.",
    "Do not call unavailable tool names; use only tools exposed in this session.",
    ...OPENCODE_TOOL_ALIAS_GUIDANCE_LINES,
    OPENCODE_BUILTIN_ALLOWLIST_LINE,
    "For todo tracking in OpenCode, use only: todowrite.",
    "todowrite requires input like {\"todos\":[{\"content\":\"...\",\"status\":\"pending|in_progress|completed|cancelled\",\"priority\":\"high|medium|low\"}]}.",
    "Use task only for subagent delegation; task requires description, prompt, and subagent_type (optional task_id).",
    "Do not invent todo tool aliases such as create_todo_list, add_todos, read_todos, mark_todo_as_done, remove_todos, or todolist.",
    "Do not print raw tool-call JSON in assistant text; invoke tools directly.",
  ].join("\n");
}

function stringifyOpenCodeToolContent(content: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(content);
    return typeof serialized === "string" && serialized.length > 0 ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function readOpenCodeBridgeString(
  params: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function readOpenCodeBridgeSessionId(params: Record<string, unknown>): string | undefined {
  return typeof params.sessionId === "string" ? params.sessionId : undefined;
}

function resolveOpenCodeBridgePath(input: {
  readonly rawPath: string;
  readonly fallbackCwd: string;
}): string {
  const trimmed = input.rawPath.trim();
  if (trimmed.length === 0) {
    throw new Error("OpenCode ACP client bridge requires a non-empty path.");
  }
  if (trimmed.startsWith("file://")) {
    return fileURLToPath(trimmed);
  }
  return isAbsolute(trimmed) ? trimmed : resolve(input.fallbackCwd, trimmed);
}

function toOpenCodeTerminalExitStatus(
  code: number | null,
  signal: NodeJS.Signals | null,
): acp.TerminalExitStatus {
  if (signal) {
    return { signal };
  }
  return { exitCode: code ?? 1 };
}

function appendOpenCodeTerminalOutput(
  terminal: OpenCodeBridgeTerminalState,
  chunk: string,
): void {
  if (chunk.length === 0) {
    return;
  }
  terminal.output = `${terminal.output}${chunk}`;
  if (terminal.output.length > OPENCODE_BRIDGE_MAX_TERMINAL_OUTPUT_CHARS) {
    terminal.truncated = true;
    terminal.output = terminal.output.slice(
      terminal.output.length - OPENCODE_BRIDGE_MAX_TERMINAL_OUTPUT_CHARS,
    );
  }
}

function withTimeout<T>(input: {
  readonly label: string;
  readonly timeoutMs: number;
  readonly promise: Promise<T>;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new TimeoutError({
          label: input.label,
          timeoutMs: input.timeoutMs,
        }),
      );
    }, input.timeoutMs);

    input.promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class OpenCodeAcpManager extends EventEmitter<OpenCodeAcpManagerEvents> {
  private readonly sessions = new Map<ThreadId, OpenCodeSessionContext>();
  private readonly startingSessions = new Map<ThreadId, OpenCodeSessionContext>();

  private emitRuntimeEvent(event: ProviderRuntimeEvent) {
    this.emit("event", event);
  }

  private createEventBase(context: OpenCodeSessionContext) {
    return {
      eventId: EventId.makeUnsafe(randomUUID()),
      provider: "opencode" as const,
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
    };
  }

  private consumeOpenCodeToolSchemaFailure(
    context: OpenCodeSessionContext,
  ): OpenCodeToolSchemaFailure | undefined {
    const failure = context.lastToolSchemaFailure;
    context.lastToolSchemaFailure = undefined;
    return failure;
  }

  private emitOpenCodeToolRetryWarning(
    context: OpenCodeSessionContext,
    turnId: TurnId,
    failureKind: OpenCodeToolInvocationFailureKind,
    error: string,
  ) {
    const kindLabel =
      failureKind === "schema" ? "schema validation" : "unavailable tool selection";
    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      turnId,
      type: "runtime.warning",
      payload: {
        message: `OpenCode tool call failed (${kindLabel}). Retrying automatically with corrected tool guidance.`,
        detail: { error, failureKind },
      },
    });
  }

  private emitOpenCodeRetrySuppressedWarning(
    context: OpenCodeSessionContext,
    turnId: TurnId,
    failureKind: OpenCodeToolInvocationFailureKind,
    error: string,
  ) {
    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      turnId,
      type: "runtime.warning",
      payload: {
        message:
          "OpenCode repeated an unavailable tool failure after an automatic retry; no further retries will run for this turn.",
        detail: { error, failureKind },
      },
    });
  }

  private ensureOpenCodeBridgeSession(
    context: OpenCodeSessionContext,
    params: Record<string, unknown>,
  ): void {
    const sessionId = readOpenCodeBridgeSessionId(params);
    if (sessionId && sessionId !== context.acpSessionId) {
      throw new Error(
        `OpenCode ACP client bridge request targeted unknown session '${sessionId}'.`,
      );
    }
  }

  private getOpenCodeBridgeTerminalOrThrow(
    context: OpenCodeSessionContext,
    terminalId: string,
  ): OpenCodeBridgeTerminalState {
    const terminal = context.bridgeTerminals.get(terminalId);
    if (!terminal) {
      throw new Error(`OpenCode ACP client bridge terminal '${terminalId}' was not found.`);
    }
    return terminal;
  }

  private resolveOpenCodeBridgeTerminalExit(
    terminal: OpenCodeBridgeTerminalState,
    status: acp.TerminalExitStatus,
  ): void {
    if (terminal.exitStatus) {
      return;
    }
    terminal.exitStatus = status;
    terminal.resolveWaitForExit(status);
  }

  private disposeOpenCodeBridgeTerminals(context: OpenCodeSessionContext): void {
    for (const terminal of context.bridgeTerminals.values()) {
      if (!terminal.exitStatus) {
        this.resolveOpenCodeBridgeTerminalExit(terminal, {
          signal: "SIGTERM",
        });
        killChildTree(terminal.child);
      }
    }
    context.bridgeTerminals.clear();
  }

  private async openCodeBridgeReadTextFile(
    context: OpenCodeSessionContext,
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    const request = params as acp.ReadTextFileRequest & Record<string, unknown>;
    this.ensureOpenCodeBridgeSession(context, request);
    const rawPath = readOpenCodeBridgeString(request, ["path", "uri"]);
    if (!rawPath) {
      throw new Error("OpenCode ACP client bridge readTextFile requires a path.");
    }
    const fallbackCwd = context.session.cwd ?? process.cwd();
    const resolvedPath = resolveOpenCodeBridgePath({
      rawPath,
      fallbackCwd,
    });
    const content = await readFile(resolvedPath, "utf8");
    return { content };
  }

  private async openCodeBridgeWriteTextFile(
    context: OpenCodeSessionContext,
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    const request = params as acp.WriteTextFileRequest & Record<string, unknown>;
    this.ensureOpenCodeBridgeSession(context, request);
    const rawPath = readOpenCodeBridgeString(request, ["uri", "path"]);
    if (!rawPath) {
      throw new Error("OpenCode ACP client bridge writeTextFile requires a path.");
    }
    const content = params.content;
    const fallbackCwd = context.session.cwd ?? process.cwd();
    const resolvedPath = resolveOpenCodeBridgePath({
      rawPath,
      fallbackCwd,
    });
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, content, "utf8");
    return {};
  }

  private async openCodeBridgeCreateTerminal(
    context: OpenCodeSessionContext,
    params: acp.CreateTerminalRequest,
  ): Promise<acp.CreateTerminalResponse> {
    const request = params as acp.CreateTerminalRequest & Record<string, unknown>;
    this.ensureOpenCodeBridgeSession(context, request);
    const command = readOpenCodeBridgeString(request, ["command"]);
    if (!command) {
      throw new Error("OpenCode ACP client bridge createTerminal requires a command.");
    }
    const args = params.args ?? [];
    const fallbackCwd = context.session.cwd ?? process.cwd();
    const requestedCwd = readOpenCodeBridgeString(request, ["cwd"]);
    const cwd = requestedCwd
      ? resolveOpenCodeBridgePath({ rawPath: requestedCwd, fallbackCwd })
      : fallbackCwd;
    const envOverrides = Object.fromEntries(
      (params.env ?? [])
        .map((entry) => [entry.name.trim(), entry.value] as const)
        .filter(([name]) => name.length > 0),
    );
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...envOverrides,
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const terminalId = `draft-opencode-terminal-${context.nextBridgeTerminalOrdinal}-${randomUUID()}`;
    context.nextBridgeTerminalOrdinal += 1;

    let resolveWaitForExit: (status: acp.TerminalExitStatus) => void = () => undefined;
    const waitForExit = new Promise<acp.TerminalExitStatus>((resolvePromise) => {
      resolveWaitForExit = resolvePromise;
    });
    const terminal: OpenCodeBridgeTerminalState = {
      terminalId,
      child,
      output: "",
      truncated: false,
      exitStatus: undefined,
      waitForExit,
      resolveWaitForExit,
    };
    context.bridgeTerminals.set(terminalId, terminal);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      appendOpenCodeTerminalOutput(terminal, chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      appendOpenCodeTerminalOutput(terminal, chunk);
    });
    child.once("exit", (code, signal) => {
      this.resolveOpenCodeBridgeTerminalExit(terminal, toOpenCodeTerminalExitStatus(code, signal));
    });
    child.once("error", (error) => {
      appendOpenCodeTerminalOutput(terminal, `${toMessage(error, "Terminal failed to start.")}\n`);
      this.resolveOpenCodeBridgeTerminalExit(terminal, { exitCode: 1 });
    });
    return { terminalId };
  }

  private async openCodeBridgeTerminalOutput(
    context: OpenCodeSessionContext,
    params: acp.TerminalOutputRequest,
  ): Promise<acp.TerminalOutputResponse> {
    const request = params as acp.TerminalOutputRequest & Record<string, unknown>;
    this.ensureOpenCodeBridgeSession(context, request);
    const terminalId = readOpenCodeBridgeString(request, ["terminalId"]);
    if (!terminalId) {
      throw new Error("OpenCode ACP client bridge terminalOutput requires terminalId.");
    }
    const terminal = this.getOpenCodeBridgeTerminalOrThrow(context, terminalId);
    return terminal.exitStatus
      ? { output: terminal.output, truncated: terminal.truncated, exitStatus: terminal.exitStatus }
      : { output: terminal.output, truncated: terminal.truncated };
  }

  private async openCodeBridgeWaitForTerminalExit(
    context: OpenCodeSessionContext,
    params: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> {
    const request = params as acp.WaitForTerminalExitRequest & Record<string, unknown>;
    this.ensureOpenCodeBridgeSession(context, request);
    const terminalId = readOpenCodeBridgeString(request, ["terminalId"]);
    if (!terminalId) {
      throw new Error("OpenCode ACP client bridge waitForTerminalExit requires terminalId.");
    }
    const terminal = this.getOpenCodeBridgeTerminalOrThrow(context, terminalId);
    const exitStatus = terminal.exitStatus ?? (await terminal.waitForExit);
    return { ...exitStatus };
  }

  private async openCodeBridgeKillTerminal(
    context: OpenCodeSessionContext,
    params: acp.KillTerminalRequest,
  ): Promise<acp.KillTerminalResponse> {
    const request = params as acp.KillTerminalRequest & Record<string, unknown>;
    this.ensureOpenCodeBridgeSession(context, request);
    const terminalId = readOpenCodeBridgeString(request, ["terminalId"]);
    if (!terminalId) {
      throw new Error("OpenCode ACP client bridge killTerminal requires terminalId.");
    }
    const terminal = this.getOpenCodeBridgeTerminalOrThrow(context, terminalId);
    if (!terminal.exitStatus) {
      this.resolveOpenCodeBridgeTerminalExit(terminal, {
        signal: "SIGTERM",
      });
      killChildTree(terminal.child);
    }
    return {};
  }

  private async openCodeBridgeReleaseTerminal(
    context: OpenCodeSessionContext,
    params: acp.ReleaseTerminalRequest,
  ): Promise<acp.ReleaseTerminalResponse> {
    const request = params as acp.ReleaseTerminalRequest & Record<string, unknown>;
    this.ensureOpenCodeBridgeSession(context, request);
    const terminalId = readOpenCodeBridgeString(request, ["terminalId"]);
    if (!terminalId) {
      throw new Error("OpenCode ACP client bridge releaseTerminal requires terminalId.");
    }
    const terminal = context.bridgeTerminals.get(terminalId);
    if (!terminal) {
      return {};
    }
    if (!terminal.exitStatus) {
      this.resolveOpenCodeBridgeTerminalExit(terminal, {
        signal: "SIGTERM",
      });
      killChildTree(terminal.child);
    }
    context.bridgeTerminals.delete(terminalId);
    return {};
  }

  private updateSession(
    context: OpenCodeSessionContext,
    patch: Partial<ProviderSession>,
  ): ProviderSession {
    context.session = {
      ...context.session,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    return context.session;
  }

  private emitSessionConfigured(context: OpenCodeSessionContext) {
    if (!context.models) {
      return;
    }

    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      type: "session.configured",
      payload: {
        config: {
          currentModelId: context.models.currentModelId,
          availableModels: context.models.availableModels,
        },
      },
    });
  }

  private emitSessionStarted(context: OpenCodeSessionContext) {
    const sessionStarted: ProviderRuntimeEvent = {
      ...this.createEventBase(context),
      type: "session.started",
      payload: {
        message: "Connected to OpenCode ACP server.",
        resume: context.session.resumeCursor,
      },
    };
    const threadStarted: ProviderRuntimeEvent = {
      ...this.createEventBase(context),
      type: "thread.started",
      payload: {
        providerThreadId: context.acpSessionId,
      },
    };
    this.emitRuntimeEvent(sessionStarted);
    this.emitRuntimeEvent(threadStarted);
    this.emitSessionConfigured(context);
  }

  private emitSessionExit(
    context: OpenCodeSessionContext,
    input: {
      readonly reason?: string;
      readonly exitKind: "graceful" | "error";
      readonly recoverable?: boolean;
    },
  ) {
    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      type: "session.exited",
      payload: {
        ...(input.reason ? { reason: input.reason } : {}),
        exitKind: input.exitKind,
        recoverable: input.recoverable ?? false,
      },
    });
  }

  private emitRuntimeError(context: OpenCodeSessionContext, message: string, turnId?: TurnId) {
    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      ...(turnId ? { turnId } : {}),
      type: "runtime.error",
      payload: {
        message,
      },
    });
  }

  private emitTurnFailed(input: {
    readonly context: OpenCodeSessionContext;
    readonly turnId: TurnId;
    readonly message: string;
    readonly recoverable: boolean;
  }) {
    this.emitRuntimeEvent({
      ...this.createEventBase(input.context),
      turnId: input.turnId,
      type: "turn.completed",
      payload: {
        state: "failed",
        stopReason: null,
        errorMessage: input.message,
      },
    });
    this.emitRuntimeError(input.context, input.message, input.turnId);
    this.updateSession(input.context, {
      status: input.recoverable ? "ready" : "error",
      activeTurnId: undefined,
      lastError: input.message,
    });
  }

  private async promptWithWatchdog(input: {
    readonly context: OpenCodeSessionContext;
    readonly turnId: TurnId;
    readonly phase: OpenCodePromptPhase;
    readonly promptText: string;
  }) {
    const label =
      input.phase === "retry" ? "OpenCode ACP retry prompt" : "OpenCode ACP prompt";

    try {
      return await withTimeout({
        label,
        timeoutMs: input.context.promptTimeoutMs,
        promise: input.context.connection.prompt({
          sessionId: input.context.acpSessionId,
          prompt: [
            {
              type: "text",
              text: input.promptText,
            },
          ],
        }),
      });
    } catch (error) {
      if (!isTimeoutError(error)) {
        throw error;
      }

      let cancelErrorMessage: string | undefined;
      try {
        await input.context.connection.cancel({ sessionId: input.context.acpSessionId });
      } catch (cancelError) {
        cancelErrorMessage = toMessage(
          cancelError,
          "Failed to cancel timed-out OpenCode prompt.",
        );
      }

      const phaseLabel =
        input.phase === "retry" ? "OpenCode retry prompt" : "OpenCode prompt";
      this.emitRuntimeEvent({
        ...this.createEventBase(input.context),
        turnId: input.turnId,
        type: "runtime.warning",
        payload: {
          message: `${phaseLabel} timed out after ${input.context.promptTimeoutMs}ms. Attempting cancellation.`,
          detail: {
            phase: input.phase,
            timeoutMs: input.context.promptTimeoutMs,
            ...(cancelErrorMessage ? { cancelError: cancelErrorMessage } : {}),
          },
        },
      });

      const message = cancelErrorMessage
        ? `${phaseLabel} timed out after ${input.context.promptTimeoutMs}ms. Draft attempted to cancel the in-flight request, but OpenCode returned: ${cancelErrorMessage}`
        : `${phaseLabel} timed out after ${input.context.promptTimeoutMs}ms. Draft cancelled the in-flight request so you can retry this turn.`;
      throw new OpenCodePromptTimeoutError({
        message,
        timeoutMs: input.context.promptTimeoutMs,
        phase: input.phase,
        cause: error,
      });
    }
  }

  private resolvePendingApprovalsAsCancelled(context: OpenCodeSessionContext) {
    for (const pending of context.pendingApprovals.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    context.pendingApprovals.clear();
  }

  private handleSessionUpdate(context: OpenCodeSessionContext, params: acp.SessionNotification) {
    const turnId = context.currentTurnId;
    const createdAt = new Date().toISOString();
    const base = {
      ...this.createEventBase(context),
      ...(turnId ? { turnId } : {}),
      createdAt,
    };

    switch (params.update.sessionUpdate) {
      case "agent_message_chunk": {
        const delta = extractTextFromContentBlock(params.update.content);
        if (!delta || delta.length === 0) {
          return;
        }
        this.emitRuntimeEvent({
          ...base,
          ...(params.update.messageId
            ? { itemId: RuntimeItemId.makeUnsafe(params.update.messageId) }
            : {}),
          type: "content.delta",
          payload: {
            delta,
            streamKind: "assistant_text",
          },
        });
        return;
      }

      case "agent_thought_chunk": {
        const delta = extractTextFromContentBlock(params.update.content);
        if (!delta || delta.length === 0) {
          return;
        }
        this.emitRuntimeEvent({
          ...base,
          ...(params.update.messageId
            ? { itemId: RuntimeItemId.makeUnsafe(params.update.messageId) }
            : {}),
          type: "content.delta",
          payload: {
            delta,
            streamKind: "reasoning_text",
          },
        });
        return;
      }

      case "plan": {
        this.emitRuntimeEvent({
          ...base,
          type: "turn.plan.updated",
          payload: {
            plan: params.update.entries.map((entry) => ({
              step: entry.content,
              status: mapPlanEntryStatus(entry.status),
            })),
          },
        });
        return;
      }

      case "usage_update": {
        this.emitRuntimeEvent({
          ...base,
          type: "thread.token-usage.updated",
          payload: {
            usage: params.update,
          },
        });
        return;
      }

      case "tool_call": {
        context.toolSnapshots.set(params.update.toolCallId, {
          kind: params.update.kind ?? null,
          title: params.update.title,
        });
        this.emitRuntimeEvent({
          ...base,
          itemId: RuntimeItemId.makeUnsafe(params.update.toolCallId),
          type: "item.started",
          payload: {
            itemType: mapToolKindToItemType(params.update.kind),
            title: params.update.title,
            ...(mapToolCallStatus(params.update.status)
              ? { status: mapToolCallStatus(params.update.status) }
              : {}),
            ...(summarizeToolContent(params.update.content)
              ? { detail: summarizeToolContent(params.update.content) }
              : {}),
            data: {
              ...(params.update.locations ? { locations: params.update.locations } : {}),
              ...(params.update.rawInput !== undefined ? { rawInput: params.update.rawInput } : {}),
              ...(params.update.rawOutput !== undefined
                ? { rawOutput: params.update.rawOutput }
                : {}),
            },
          },
        });
        return;
      }

      case "tool_call_update": {
        const previous = context.toolSnapshots.get(params.update.toolCallId);
        const nextSnapshot = {
          kind: params.update.kind ?? previous?.kind ?? null,
          title: params.update.title ?? previous?.title ?? "Tool call",
        } satisfies ToolSnapshot;
        context.toolSnapshots.set(params.update.toolCallId, nextSnapshot);
        const status = params.update.status ?? null;
        const eventType =
          status === "completed" || status === "failed" ? "item.completed" : "item.updated";
        this.emitRuntimeEvent({
          ...base,
          itemId: RuntimeItemId.makeUnsafe(params.update.toolCallId),
          type: eventType,
          payload: {
            itemType: mapToolKindToItemType(nextSnapshot.kind),
            title: nextSnapshot.title,
            ...(mapToolCallStatus(status) ? { status: mapToolCallStatus(status) } : {}),
            ...(summarizeToolContent(params.update.content)
              ? { detail: summarizeToolContent(params.update.content) }
              : {}),
            ...(params.update.content ? { data: { content: params.update.content } } : {}),
          },
        });
        if (status === "failed") {
          const failureMessage = [
            nextSnapshot.title,
            summarizeToolContent(params.update.content),
            stringifyOpenCodeToolContent(params.update.content),
          ]
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .join("\n")
            .trim()
            .slice(0, 2_000);
          const failureKind = classifyOpenCodeToolInvocationFailure(failureMessage);
          if (failureKind) {
            context.lastToolSchemaFailure = {
              kind: failureKind,
              message: failureMessage,
            };
          }
        }
        return;
      }

      default:
        return;
    }
  }

  private async requestPermission(
    context: OpenCodeSessionContext,
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
    const requestType = mapToolKindToRequestType(params.toolCall.kind);
    const detail = params.toolCall.title?.trim() ?? "Permission requested";

    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      ...(context.currentTurnId ? { turnId: context.currentTurnId } : {}),
      requestId: RuntimeRequestId.makeUnsafe(requestId),
      type: "request.opened",
      payload: {
        requestType,
        ...(detail.length > 0 ? { detail } : {}),
      },
    });

    const response = await new Promise<acp.RequestPermissionResponse>((resolve) => {
      context.pendingApprovals.set(requestId, {
        requestId,
        toolCallId: params.toolCall.toolCallId,
        turnId: context.currentTurnId,
        requestType,
        options: params.options,
        resolve,
      });
    });

    context.pendingApprovals.delete(requestId);
    this.emitRuntimeEvent({
      ...this.createEventBase(context),
      ...(context.currentTurnId ? { turnId: context.currentTurnId } : {}),
      requestId: RuntimeRequestId.makeUnsafe(requestId),
      type: "request.resolved",
      payload: {
        requestType,
        decision: permissionDecisionFromOutcome(response.outcome, params.options),
      },
    });
    return response;
  }

  private attachProcessListeners(context: OpenCodeSessionContext) {
    context.child.stderr.setEncoding("utf8");
    context.child.stderr.on("data", (chunk: string) => {
      const trimmed = chunk.trim();
      if (trimmed.length > 0) {
        context.lastStderrLine = trimmed.split("\n").at(-1)?.trim() ?? trimmed;
      }
    });

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!this.isTrackedContext(context)) {
        return;
      }

      this.resolvePendingApprovalsAsCancelled(context);
      this.disposeOpenCodeBridgeTerminals(context);
      this.updateSession(context, {
        status: "closed",
      });

      if (!context.stopping) {
        const reason =
          context.lastStderrLine ??
          (signal ? `OpenCode exited from signal ${signal}.` : undefined) ??
          (code !== null ? `OpenCode exited with code ${code}.` : "OpenCode exited.");
        this.emitSessionExit(context, {
          reason,
          exitKind: code === 0 ? "graceful" : "error",
        });
        if (code !== 0 && context.currentTurnId) {
          this.emitRuntimeError(context, reason, context.currentTurnId);
        }
      }

      this.deleteTrackedSession(context.session.threadId, context);
    };

    context.child.once("error", (error) => {
      context.lastStderrLine = toMessage(error, "Failed to start OpenCode CLI.");
      onExit(null, null);
    });

    context.child.once("exit", onExit);
    context.connection.closed.catch(() => undefined);
  }

  private requireSession(threadId: ThreadId): OpenCodeSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown OpenCode session: ${threadId}`);
    }
    if (context.session.status === "closed") {
      throw new Error(`OpenCode session is closed: ${threadId}`);
    }
    return context;
  }

  private async setSessionModel(context: OpenCodeSessionContext, model: string) {
    const availableModelIds = readAvailableOpenCodeModelIds(context.models);
    if (availableModelIds.length > 0 && !availableModelIds.includes(model)) {
      throw new Error(
        buildOpenCodeUnavailableModelMessage({
          model,
          availableModelIds,
        }),
      );
    }

    try {
      await context.connection.unstable_setSessionModel({
        sessionId: context.acpSessionId,
        modelId: model,
      });
      if (context.models) {
        context.models = {
          ...context.models,
          currentModelId: model,
        };
      }
      this.updateSession(context, { model });
      this.emitSessionConfigured(context);
    } catch (error) {
      throw new Error(toMessage(error, `Failed to switch OpenCode model to '${model}'.`), {
        cause: error,
      });
    }
  }

  async startSession(input: OpenCodeAppServerStartSessionInput): Promise<ProviderSession> {
    if (this.sessions.has(input.threadId) || this.startingSessions.has(input.threadId)) {
      throw new Error(
        `OpenCode already has a session starting or running for thread '${input.threadId}'.`,
      );
    }

    const resolvedCwd = input.cwd ?? process.cwd();
    const now = new Date().toISOString();
    const previousContext = this.sessions.get(input.threadId);
    const session: ProviderSession = {
      provider: "opencode",
      status: "connecting",
      runtimeMode: input.runtimeMode,
      model: input.model,
      cwd: resolvedCwd,
      threadId: input.threadId,
      createdAt: now,
      updatedAt: now,
    };

    const opencodeBinaryPath = input.providerOptions?.opencode?.binaryPath ?? "opencode";
    const promptTimeoutMs = normalizeOpenCodePromptTimeoutMs(
      input.providerOptions?.opencode?.promptTimeoutMs,
    );
    const useClientToolBridge = isOpenCodeClientToolBridgeEnabled(input.providerOptions);
    const args = buildOpenCodeCliArgs({ cwd: resolvedCwd });
    const env = buildOpenCodeCliEnv({
      runtimeMode: input.runtimeMode,
      ...(input.providerOptions?.opencode?.openRouterApiKey
        ? { openRouterApiKey: input.providerOptions.opencode.openRouterApiKey }
        : {}),
      ...(input.providerOptions?.opencode?.configContent
        ? { configContent: input.providerOptions.opencode.configContent }
        : {}),
      ...(input.providerOptions?.opencode?.envOverrides
        ? { envOverrides: input.providerOptions.opencode.envOverrides }
        : {}),
    });

    const child = spawn(opencodeBinaryPath, args, {
      cwd: resolvedCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    let context: OpenCodeSessionContext | undefined;

    const client: acp.Client = {
      requestPermission: async (params) => {
        if (!context) {
          return { outcome: { outcome: "cancelled" } };
        }
        return this.requestPermission(context, params);
      },
      sessionUpdate: async (params) => {
        if (!context) {
          return;
        }
        this.handleSessionUpdate(context, params);
      },
      ...(useClientToolBridge
        ? {
            readTextFile: async (params: acp.ReadTextFileRequest) => {
              if (!context || !context.bridgeEnabled) {
                throw new Error("OpenCode ACP client bridge readTextFile is unavailable.");
              }
              return this.openCodeBridgeReadTextFile(context, params);
            },
            writeTextFile: async (params: acp.WriteTextFileRequest) => {
              if (!context || !context.bridgeEnabled) {
                throw new Error("OpenCode ACP client bridge writeTextFile is unavailable.");
              }
              return this.openCodeBridgeWriteTextFile(context, params);
            },
            createTerminal: async (params: acp.CreateTerminalRequest) => {
              if (!context || !context.bridgeEnabled) {
                throw new Error("OpenCode ACP client bridge createTerminal is unavailable.");
              }
              return this.openCodeBridgeCreateTerminal(context, params);
            },
            terminalOutput: async (params: acp.TerminalOutputRequest) => {
              if (!context || !context.bridgeEnabled) {
                throw new Error("OpenCode ACP client bridge terminalOutput is unavailable.");
              }
              return this.openCodeBridgeTerminalOutput(context, params);
            },
            waitForTerminalExit: async (params: acp.WaitForTerminalExitRequest) => {
              if (!context || !context.bridgeEnabled) {
                throw new Error("OpenCode ACP client bridge waitForTerminalExit is unavailable.");
              }
              return this.openCodeBridgeWaitForTerminalExit(context, params);
            },
            killTerminal: async (params: acp.KillTerminalRequest) => {
              if (!context || !context.bridgeEnabled) {
                throw new Error("OpenCode ACP client bridge killTerminal is unavailable.");
              }
              return this.openCodeBridgeKillTerminal(context, params);
            },
            releaseTerminal: async (params: acp.ReleaseTerminalRequest) => {
              if (!context || !context.bridgeEnabled) {
                throw new Error("OpenCode ACP client bridge releaseTerminal is unavailable.");
              }
              return this.openCodeBridgeReleaseTerminal(context, params);
            },
          }
        : {}),
    };

    const connection = new acp.ClientSideConnection(() => client, stream);
    context = {
      session,
      child,
      connection,
      acpSessionId: "",
      models: null,
      promptTimeoutMs,
      pendingApprovals: new Map(),
      toolSnapshots: new Map(),
      currentTurnId: undefined,
      turnInFlight: false,
      stopping: false,
      bridgeEnabled: useClientToolBridge,
      bridgeTerminals: new Map(),
      nextBridgeTerminalOrdinal: 1,
      lastToolSchemaFailure: undefined,
    };
    this.startingSessions.set(input.threadId, context);
    this.attachProcessListeners(context);

    try {
      const initializeResult = await withTimeout({
        label: "OpenCode ACP initialize",
        timeoutMs: OPENCODE_ACP_INITIALIZE_TIMEOUT_MS,
        promise: connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: buildOpenCodeClientCapabilities({
            useClientToolBridge,
          }),
        }),
      });

      const resumeSessionId = readResumeSessionId(input);
      const resumeSupported =
        initializeResult.agentCapabilities?.sessionCapabilities?.resume !== undefined;

      let sessionResult: acp.NewSessionResponse | acp.ResumeSessionResponse;
      if (resumeSessionId) {
        if (!resumeSupported) {
          throw new Error("OpenCode ACP server does not advertise session resume support.");
        }

        sessionResult = await withTimeout({
          label: "OpenCode ACP resumeSession",
          timeoutMs: OPENCODE_ACP_SESSION_START_TIMEOUT_MS,
          promise: connection.unstable_resumeSession({
            sessionId: resumeSessionId,
            cwd: resolvedCwd,
            mcpServers: [],
          }),
        });
        context.acpSessionId = resumeSessionId;
      } else {
        const createdSession = await withTimeout({
          label: "OpenCode ACP newSession",
          timeoutMs: OPENCODE_ACP_SESSION_START_TIMEOUT_MS,
          promise: connection.newSession({
            cwd: resolvedCwd,
            mcpServers: [],
          }),
        });
        sessionResult = createdSession;
        context.acpSessionId = createdSession.sessionId;
      }

      context.models = sessionResult.models ?? null;
      this.updateSession(context, {
        status: "ready",
        model: sessionResult.models?.currentModelId ?? session.model,
        resumeCursor: { sessionId: context.acpSessionId },
      });

      const requestedModel = normalizeRequestedOpenCodeModel(input.model);
      if (requestedModel && requestedModel !== context.session.model) {
        await this.setSessionModel(context, requestedModel);
      }

      this.emitSessionStarted(context);
      this.startingSessions.delete(input.threadId);
      this.sessions.set(input.threadId, context);
      if (previousContext && previousContext !== context) {
        await this.disposeContext(previousContext);
      }
      return { ...context.session };
    } catch (error) {
      const rawMessage =
        context.lastStderrLine ?? toMessage(error, "Failed to start OpenCode session.");
      const message = normalizeOpenCodeStartErrorMessage(rawMessage);
      this.startingSessions.delete(input.threadId);
      this.updateSession(context, {
        status: "error",
        lastError: message,
      });
      this.emitRuntimeError(context, message);
      if (this.isTrackedContext(context)) {
        this.emitSessionExit(context, {
          reason: message,
          exitKind: "error",
        });
      }
      await this.disposeContext(context);
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: {
    readonly threadId: ThreadId;
    readonly input?: string;
    readonly attachments?: ReadonlyArray<unknown>;
    readonly model?: string;
  }): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    const promptText = input.input?.trim();
    if (!promptText) {
      throw new Error("OpenCode turns require a non-empty text prompt.");
    }
    if ((input.attachments?.length ?? 0) > 0) {
      throw new Error("OpenCode integration currently supports text prompts only.");
    }

    if (
      context.turnInFlight ||
      context.session.status === "running" ||
      context.session.activeTurnId
    ) {
      throw new Error("OpenCode already has a turn in progress for this session.");
    }

    context.turnInFlight = true;
    context.lastToolSchemaFailure = undefined;

    try {
      const requestedModel = normalizeRequestedOpenCodeModel(input.model);
      if (requestedModel && requestedModel !== context.session.model) {
        await this.setSessionModel(context, requestedModel);
      }

      const turnId = TurnId.makeUnsafe(randomUUID());
      context.currentTurnId = turnId;
      this.updateSession(context, {
        status: "running",
        activeTurnId: turnId,
      });

      this.emitRuntimeEvent({
        ...this.createEventBase(context),
        turnId,
        type: "turn.started",
        payload: context.session.model ? { model: context.session.model } : {},
      });

      const completeTurn = (result: { stopReason: string | null; usage?: unknown }) => {
        this.emitRuntimeEvent({
          ...this.createEventBase(context),
          turnId,
          type: "turn.completed",
          payload: {
            state: result.stopReason === "cancelled" ? "interrupted" : "completed",
            stopReason: result.stopReason,
            ...(result.usage ? { usage: result.usage } : {}),
          },
        });
        this.updateSession(context, {
          status: "ready",
          activeTurnId: undefined,
          lastError: undefined,
        });
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: { sessionId: context.acpSessionId },
        } satisfies ProviderTurnStartResult;
      };
      let toolFailureRetryAttempted = false;
      let retriedFailureKind: OpenCodeToolInvocationFailureKind | null = null;
      const attemptToolFailureRetry = async (input: {
        readonly failure: OpenCodeToolSchemaFailure | undefined;
        readonly fallbackMessage: string;
      }): Promise<ProviderTurnStartResult | undefined> => {
        const retrySourceMessage = input.failure?.message ?? input.fallbackMessage;
        const failureKind =
          input.failure?.kind ?? classifyOpenCodeToolInvocationFailure(retrySourceMessage);
        if (!failureKind) {
          return undefined;
        }
        if (toolFailureRetryAttempted) {
          if (retriedFailureKind === "unavailable" && failureKind === "unavailable") {
            this.emitOpenCodeRetrySuppressedWarning(
              context,
              turnId,
              failureKind,
              retrySourceMessage,
            );
          }
          return undefined;
        }
        const recoveryPrompt = buildOpenCodeToolSchemaRecoveryPrompt({
          rawMessage: retrySourceMessage,
          originalUserRequest: promptText,
        });
        if (!recoveryPrompt) {
          return undefined;
        }
        toolFailureRetryAttempted = true;
        retriedFailureKind = failureKind;
        this.emitOpenCodeToolRetryWarning(context, turnId, failureKind, retrySourceMessage);
        const retryResult = await this.promptWithWatchdog({
          context,
          turnId,
          phase: "retry",
          promptText: recoveryPrompt,
        });
        return completeTurn(retryResult);
      };

      try {
        const result = await this.promptWithWatchdog({
          context,
          turnId,
          phase: "primary",
          promptText,
        });

        const streamedToolSchemaFailure = this.consumeOpenCodeToolSchemaFailure(context);
        if (streamedToolSchemaFailure) {
          const retryResult = await attemptToolFailureRetry({
            failure: streamedToolSchemaFailure,
            fallbackMessage: streamedToolSchemaFailure.message,
          });
          if (retryResult) {
            return retryResult;
          }
        }

        return completeTurn(result);
      } catch (error) {
        let message = toMessage(error, "OpenCode turn failed.");
        let recoverable = isOpenCodePromptTimeoutError(error);
        let failureCause: unknown = error;
        if (!recoverable) {
          const streamedToolSchemaFailure = this.consumeOpenCodeToolSchemaFailure(context);
          try {
            const retryResult = await attemptToolFailureRetry({
              failure: streamedToolSchemaFailure,
              fallbackMessage: message,
            });
            if (retryResult) {
              return retryResult;
            }
          } catch (retryError) {
            const retryMessage = toMessage(
              retryError,
              "Automatic retry after tool-call failure failed.",
            );
            message = `${message} Automatic retry failed: ${retryMessage}`;
            recoverable = isOpenCodePromptTimeoutError(retryError);
            failureCause = retryError;
          }
        }
        this.emitTurnFailed({
          context,
          turnId,
          message,
          recoverable,
        });
        throw new Error(message, { cause: failureCause });
      }
    } finally {
      context.currentTurnId = undefined;
      context.turnInFlight = false;
      context.lastToolSchemaFailure = undefined;
    }
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const context = this.requireSession(threadId);
    if (turnId && context.currentTurnId && turnId !== context.currentTurnId) {
      return;
    }
    this.resolvePendingApprovalsAsCancelled(context);
    await context.connection.cancel({ sessionId: context.acpSessionId });
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pending = context.pendingApprovals.get(requestId);
    if (!pending) {
      throw new Error(`Unknown pending OpenCode approval request: ${requestId}`);
    }
    pending.resolve(createPermissionOutcome(decision, pending.options));
  }

  async respondToUserInput(): Promise<void> {
    throw new Error("OpenCode ACP does not expose structured user input requests in Draft yet.");
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const context = this.sessions.get(threadId) ?? this.startingSessions.get(threadId);
    if (!context) {
      return;
    }

    await this.disposeContext(context);
    this.emitSessionExit(context, {
      reason: "OpenCode session stopped.",
      exitKind: "graceful",
      recoverable: true,
    });
  }

  private deleteTrackedSession(threadId: ThreadId, context: OpenCodeSessionContext): void {
    if (this.sessions.get(threadId) === context) {
      this.sessions.delete(threadId);
    }
    if (this.startingSessions.get(threadId) === context) {
      this.startingSessions.delete(threadId);
    }
  }

  private isTrackedContext(context: OpenCodeSessionContext): boolean {
    const threadId = context.session.threadId;
    return (
      this.sessions.get(threadId) === context || this.startingSessions.get(threadId) === context
    );
  }

  private async disposeContext(context: OpenCodeSessionContext): Promise<void> {
    context.stopping = true;
    this.resolvePendingApprovalsAsCancelled(context);
    this.disposeOpenCodeBridgeTerminals(context);
    try {
      await context.connection.cancel({ sessionId: context.acpSessionId });
    } catch {
      // Best-effort cancellation only.
    }

    killChildTree(context.child);
    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    this.deleteTrackedSession(context.session.threadId, context);
  }

  async listSessions(): Promise<ReadonlyArray<ProviderSession>> {
    return Array.from(this.sessions.values(), (context) => context.session);
  }

  async hasSession(threadId: ThreadId): Promise<boolean> {
    return this.sessions.has(threadId) || this.startingSessions.has(threadId);
  }

  async readThread(threadId: ThreadId): Promise<OpenCodeThreadSnapshot> {
    this.requireSession(threadId);
    throw new Error(
      "Reading historical OpenCode thread snapshots is not implemented in this ACP integration yet.",
    );
  }

  async rollbackThread(threadId: ThreadId, _numTurns: number): Promise<OpenCodeThreadSnapshot> {
    this.requireSession(threadId);
    throw new Error("Rolling back OpenCode threads is not supported by this integration.");
  }

  async stopAll(): Promise<void> {
    const threadIds = [...new Set([...this.sessions.keys(), ...this.startingSessions.keys()])];
    await Promise.all(threadIds.map((threadId) => this.stopSession(threadId)));
  }
}
