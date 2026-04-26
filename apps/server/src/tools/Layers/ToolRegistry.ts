import fs from "node:fs/promises";
import path from "node:path";

import {
  TerminalExecInput,
  type ToolInvocation,
  type ToolName,
} from "@draft/contracts";
import { Effect, Layer, Schema } from "effect";

import { runProcess } from "../../processRunner.ts";
import {
  TerminalCommandRunner,
  type TerminalCommandRunnerShape,
} from "../../terminal/Services/CommandRunner.ts";
import {
  ToolExecutionError,
  ToolHarnessValidationError,
  ToolNotFoundError,
} from "../Errors.ts";
import { ToolRegistry, type ToolExecutionContext, type ToolRegistryShape } from "../Services/ToolRegistry.ts";

const decodeTerminalExecInput = Schema.decodeUnknownSync(TerminalExecInput);

type ToolAdapter = (
  context: ToolExecutionContext,
  invocation: ToolInvocation,
) => Effect.Effect<unknown, ToolExecutionError | ToolHarnessValidationError>;

type NativeCliCommand = "rg" | "fd" | "jq" | "yq" | "git" | "gh";

interface NativeCliAvailability {
  command: NativeCliCommand;
  available: boolean;
  path: string | null;
  checkedAt: string;
}

interface NativeCliExecuteInput {
  cwd: string;
  args: string[];
  stdin?: string;
  timeoutMs: number;
  maxBufferBytes?: number;
  allowNonZeroExit: boolean;
  readOnly: boolean;
}

const NATIVE_CLI_COMMANDS: readonly NativeCliCommand[] = ["rg", "fd", "jq", "yq", "git", "gh"];
const DEFAULT_CLI_TIMEOUT_MS = 60_000;
const DEFAULT_CLI_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const cliAvailabilityCache = new Map<NativeCliCommand, Promise<NativeCliAvailability>>();

export function resetNativeCliAvailabilityCacheForTests(): void {
  cliAvailabilityCache.clear();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function decodeBoundedInt(
  value: unknown,
  options: {
    label: string;
    min: number;
    max: number;
    fallback: number;
  },
): number {
  if (value === undefined) return options.fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${options.label} must be an integer`);
  }
  return Math.max(options.min, Math.min(options.max, value));
}

function decodeNativeCliInput(
  invocation: ToolInvocation,
  options: {
    requireArgs?: boolean;
  } = {},
): NativeCliExecuteInput {
  const input = asRecord(invocation.input) ?? {};
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const argsRaw = input.args;
  if (argsRaw !== undefined && !Array.isArray(argsRaw)) {
    throw new Error("args must be an array of strings");
  }
  const args = Array.isArray(argsRaw)
    ? argsRaw.filter((value): value is string => typeof value === "string")
    : [];
  if (Array.isArray(argsRaw) && args.length !== argsRaw.length) {
    throw new Error("args must only contain strings");
  }
  if (options.requireArgs !== false && args.length === 0) {
    throw new Error("args must include at least one value");
  }
  const stdin = input.stdin;
  if (stdin !== undefined && typeof stdin !== "string") {
    throw new Error("stdin must be a string when provided");
  }
  const timeoutMs = decodeBoundedInt(input.timeoutMs, {
    label: "timeoutMs",
    min: 1_000,
    max: 300_000,
    fallback: DEFAULT_CLI_TIMEOUT_MS,
  });
  const maxBufferBytes = decodeBoundedInt(input.maxBufferBytes, {
    label: "maxBufferBytes",
    min: 1_024,
    max: 64 * 1024 * 1024,
    fallback: DEFAULT_CLI_MAX_BUFFER_BYTES,
  });
  const allowNonZeroExit =
    typeof input.allowNonZeroExit === "boolean" ? input.allowNonZeroExit : true;
  const readOnly = input.readOnly === true;
  return {
    cwd,
    args,
    ...(stdin === undefined ? {} : { stdin }),
    timeoutMs,
    maxBufferBytes,
    allowNonZeroExit,
    readOnly,
  };
}

async function resolveNativeCliAvailability(
  command: NativeCliCommand,
  options: { refresh?: boolean } = {},
): Promise<NativeCliAvailability> {
  if (options.refresh) {
    cliAvailabilityCache.delete(command);
  }
  const cached = cliAvailabilityCache.get(command);
  if (cached) {
    return cached;
  }

  const pending = (async (): Promise<NativeCliAvailability> => {
    try {
      const locatorCommand = process.platform === "win32" ? "where" : "which";
      const probe = await runProcess(locatorCommand, [command], {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        outputMode: "truncate",
      });
      const firstPath =
        probe.stdout
          .split(/\r?\n/g)
          .map((line) => line.trim())
          .find((line) => line.length > 0) ?? null;
      return {
        command,
        available: probe.code === 0 && firstPath !== null,
        path: firstPath,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        command,
        available: false,
        path: null,
        checkedAt: new Date().toISOString(),
      };
    }
  })();

  cliAvailabilityCache.set(command, pending);
  return pending;
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "i");
}

function getRelativeDepth(root: string, absolutePath: string): number {
  const relative = path.relative(root, absolutePath);
  if (!relative || relative === ".") return 0;
  return relative.split(/[\\/]+/g).filter((segment) => segment.length > 0).length;
}

async function walkFilesRecursively(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const nextPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFilesRecursively(nextPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(nextPath);
    }
  }
  return files;
}

function toToolExecutionError(invocation: ToolInvocation, cause: unknown): ToolExecutionError {
  return new ToolExecutionError({
    toolName: invocation.toolName,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

async function runNativeGrep(input: {
  cwd: string;
  query: string;
  includeFiles: string[] | null;
  maxMatches: number;
}): Promise<{
  query: string;
  cwd: string;
  matches: Array<{ file: string; line: number; text: string }>;
  truncated: boolean;
  backend: "rg";
}> {
  const result = await runProcess(
    "rg",
    ["--line-number", "--no-heading", "--color", "never", input.query, "."],
    {
      cwd: input.cwd,
      timeoutMs: 30_000,
      allowNonZeroExit: true,
      outputMode: "truncate",
    },
  );
  if (result.timedOut) {
    throw new Error("rg search timed out");
  }
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`rg exited with code ${result.code}: ${result.stderr.trim() || "unknown error"}`);
  }

  const includeFilters =
    input.includeFiles && input.includeFiles.length > 0
      ? input.includeFiles.map((value) => value.toLowerCase())
      : null;
  const matches: Array<{ file: string; line: number; text: string }> = [];
  const lines = result.stdout.split(/\r?\n/g).filter((line) => line.length > 0);
  for (const line of lines) {
    const parsed = line.match(/^(.+?):(\d+):(.*)$/);
    if (!parsed) continue;
    const [, relativeFile, lineRaw, text] = parsed;
    if (!relativeFile || !lineRaw || text === undefined) continue;
    const absoluteFile = path.resolve(input.cwd, relativeFile);
    if (
      includeFilters &&
      !includeFilters.some((include) => absoluteFile.toLowerCase().includes(include))
    ) {
      continue;
    }
    matches.push({
      file: absoluteFile,
      line: Number(lineRaw),
      text,
    });
    if (matches.length >= input.maxMatches) {
      break;
    }
  }

  return {
    query: input.query,
    cwd: input.cwd,
    matches,
    truncated:
      result.stdoutTruncated === true ||
      matches.length >= input.maxMatches ||
      lines.length > matches.length,
    backend: "rg",
  };
}

async function runFilesystemGrep(input: {
  cwd: string;
  query: string;
  includeFiles: string[] | null;
  maxMatches: number;
}): Promise<{
  query: string;
  cwd: string;
  matches: Array<{ file: string; line: number; text: string }>;
  truncated: boolean;
  backend: "filesystem";
}> {
  const regex = new RegExp(input.query, "i");
  const files = await walkFilesRecursively(input.cwd);
  const includeFilters =
    input.includeFiles && input.includeFiles.length > 0
      ? input.includeFiles.map((value) => value.toLowerCase())
      : null;
  const filteredFiles =
    includeFilters === null
      ? files
      : files.filter((filePath) =>
          includeFilters.some((include) => filePath.toLowerCase().includes(include)),
        );

  const matches: Array<{ file: string; line: number; text: string }> = [];
  for (const filePath of filteredFiles) {
    if (matches.length >= input.maxMatches) break;
    let text: string;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/g);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line !== undefined && regex.test(line)) {
        matches.push({ file: filePath, line: index + 1, text: line });
        if (matches.length >= input.maxMatches) break;
      }
    }
  }
  return {
    query: input.query,
    cwd: input.cwd,
    matches,
    truncated: matches.length >= input.maxMatches,
    backend: "filesystem",
  };
}

async function runNativeFileGlob(input: {
  searchDir: string;
  patterns: string[];
  maxMatches: number;
  minDepth: number;
  maxDepth: number;
}): Promise<{
  searchDir: string;
  patterns: string[];
  matchedFiles: string[];
  truncated: boolean;
  backend: "fd";
}> {
  const matches = new Set<string>();
  let sawTruncation = false;

  for (const pattern of input.patterns) {
    if (matches.size >= input.maxMatches) break;
    const args = ["--type", "f", "--absolute-path", "--color", "never", "--glob", pattern];
    if (input.maxDepth > 0) {
      args.push("--max-depth", String(input.maxDepth));
    }
    args.push(".");
    const result = await runProcess("fd", args, {
      cwd: input.searchDir,
      timeoutMs: 30_000,
      allowNonZeroExit: true,
      outputMode: "truncate",
    });
    if (result.timedOut) {
      throw new Error("fd search timed out");
    }
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`fd exited with code ${result.code}: ${result.stderr.trim() || "unknown error"}`);
    }

    sawTruncation = sawTruncation || result.stdoutTruncated === true;
    const lines = result.stdout.split(/\r?\n/g).filter((line) => line.length > 0);
    for (const line of lines) {
      const absolutePath = path.resolve(input.searchDir, line);
      const depth = getRelativeDepth(input.searchDir, absolutePath);
      if (depth < input.minDepth) continue;
      if (input.maxDepth > 0 && depth > input.maxDepth) continue;
      matches.add(absolutePath);
      if (matches.size >= input.maxMatches) {
        break;
      }
    }
  }

  return {
    searchDir: input.searchDir,
    patterns: input.patterns,
    matchedFiles: Array.from(matches).slice(0, input.maxMatches),
    truncated: sawTruncation || matches.size >= input.maxMatches,
    backend: "fd",
  };
}

async function runFilesystemFileGlob(input: {
  searchDir: string;
  patterns: string[];
  maxMatches: number;
  minDepth: number;
  maxDepth: number;
}): Promise<{
  searchDir: string;
  patterns: string[];
  matchedFiles: string[];
  truncated: boolean;
  backend: "filesystem";
}> {
  const regexes = input.patterns.map(wildcardToRegExp);
  const files = await walkFilesRecursively(input.searchDir);
  const matched = files
    .filter((filePath) => {
      const depth = getRelativeDepth(input.searchDir, filePath);
      if (depth < input.minDepth) return false;
      if (input.maxDepth > 0 && depth > input.maxDepth) return false;
      const relativePath = path.relative(input.searchDir, filePath).replace(/\\/g, "/");
      const basename = path.basename(filePath);
      return regexes.some((regex) => regex.test(relativePath) || regex.test(basename));
    })
    .slice(0, input.maxMatches);

  return {
    searchDir: input.searchDir,
    patterns: input.patterns,
    matchedFiles: matched,
    truncated: matched.length >= input.maxMatches,
    backend: "filesystem",
  };
}

const terminalExecAdapter =
  (terminalCommandRunner: TerminalCommandRunnerShape) =>
  (_context: ToolExecutionContext, invocation: ToolInvocation) =>
    Effect.try({
      try: () => decodeTerminalExecInput(invocation.input),
      catch: (cause) =>
        new ToolHarnessValidationError({
          operation: "ToolRegistry.terminal.exec",
          issue: "Invalid terminal.exec input payload",
          cause,
        }),
    }).pipe(
      Effect.flatMap((parsed) =>
        terminalCommandRunner.exec(parsed).pipe(
          Effect.mapError(
            (cause) =>
              new ToolExecutionError({
                toolName: invocation.toolName,
                detail: cause.message,
                cause,
              }),
          ),
        ),
      ),
    );

const capabilitiesAdapter: ToolAdapter = (_context, invocation) =>
  Effect.tryPromise({
    try: async () => {
      const input = asRecord(invocation.input);
      const refresh = input?.refresh === true;
      if (refresh) {
        resetNativeCliAvailabilityCacheForTests();
      }
      const capabilities = Object.create(null) as Record<NativeCliCommand, NativeCliAvailability>;
      for (const command of NATIVE_CLI_COMMANDS) {
        capabilities[command] = await resolveNativeCliAvailability(command);
      }
      return {
        checkedAt: new Date().toISOString(),
        tools: capabilities,
      };
    },
    catch: (cause) => toToolExecutionError(invocation, cause),
  });

const makeNativeCliAdapter = (
  command: NativeCliCommand,
  options: {
    requireArgs?: boolean;
  } = {},
): ToolAdapter =>
  (context, invocation) =>
    Effect.tryPromise({
      try: async () => {
        const input = decodeNativeCliInput(invocation, options);
        const availability = await resolveNativeCliAvailability(command);
        if (!availability.available) {
          throw new Error(
            `'${command}' is not available on PATH. Run 'cli.capabilities' to inspect native CLI availability.`,
          );
        }
        const result = await runProcess(command, input.args, {
          cwd: input.cwd,
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          timeoutMs: input.timeoutMs,
          maxBufferBytes: input.maxBufferBytes,
          allowNonZeroExit: true,
          outputMode: "truncate",
        });
        if (!input.allowNonZeroExit && result.code !== 0) {
          throw new Error(
            `${command} exited with code ${result.code}: ${result.stderr.trim() || "unknown error"}`,
          );
        }
        return {
          threadId: context.threadId,
          toolName: invocation.toolName,
          command,
          commandPath: availability.path,
          cwd: input.cwd,
          args: input.args,
          readOnly: input.readOnly,
          ok: result.code === 0 && !result.timedOut,
          exitCode: result.code,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        };
      },
      catch: (cause) => toToolExecutionError(invocation, cause),
    });

const grepAdapter: ToolAdapter = (context, invocation) =>
  Effect.tryPromise({
    try: async () => {
      const input = asRecord(invocation.input) ?? {};
      const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
      const query = typeof input.query === "string" ? input.query : "";
      if (query.trim().length === 0) {
        throw new Error("query is required");
      }
      const includeFiles = Array.isArray(input.includeFiles)
        ? input.includeFiles.filter((value): value is string => typeof value === "string")
        : null;
      const maxMatches = decodeBoundedInt(input.maxMatches, {
        label: "maxMatches",
        min: 1,
        max: 2_000,
        fallback: 200,
      });

      const availability = await resolveNativeCliAvailability("rg");
      const normalizedInput = {
        cwd,
        query,
        includeFiles,
        maxMatches,
      };
      const response = availability.available
        ? await runNativeGrep(normalizedInput)
        : await runFilesystemGrep(normalizedInput);
      return {
        threadId: context.threadId,
        ...response,
      };
    },
    catch: (cause) => toToolExecutionError(invocation, cause),
  });

const fileGlobAdapter: ToolAdapter = (context, invocation) =>
  Effect.tryPromise({
    try: async () => {
      const input = asRecord(invocation.input) ?? {};
      const searchDir = typeof input.searchDir === "string" ? input.searchDir : process.cwd();
      const patterns =
        Array.isArray(input.patterns) && input.patterns.length > 0
          ? input.patterns.filter((value): value is string => typeof value === "string")
          : ["*"];
      if (patterns.length === 0) {
        throw new Error("patterns must include at least one string pattern");
      }
      const maxMatches = decodeBoundedInt(input.maxMatches, {
        label: "maxMatches",
        min: 1,
        max: 10_000,
        fallback: 500,
      });
      const minDepth = decodeBoundedInt(input.minDepth, {
        label: "minDepth",
        min: 0,
        max: 256,
        fallback: 0,
      });
      const maxDepth = decodeBoundedInt(input.maxDepth, {
        label: "maxDepth",
        min: 0,
        max: 256,
        fallback: 0,
      });
      if (maxDepth > 0 && minDepth > maxDepth) {
        throw new Error("minDepth cannot exceed maxDepth");
      }
      const normalizedInput = {
        searchDir,
        patterns,
        maxMatches,
        minDepth,
        maxDepth,
      };
      const availability = await resolveNativeCliAvailability("fd");
      const response = availability.available
        ? await runNativeFileGlob(normalizedInput)
        : await runFilesystemFileGlob(normalizedInput);
      return {
        threadId: context.threadId,
        ...response,
      };
    },
    catch: (cause) => toToolExecutionError(invocation, cause),
  });

const readFilesAdapter: ToolAdapter = (_context, invocation) =>
  Effect.tryPromise({
    try: async () => {
      const input = invocation.input as { files?: Array<{ path?: string; ranges?: string[] }> };
      const files = Array.isArray(input?.files) ? input.files : [];
      const results: Array<{ path: string; content?: string; error?: string }> = [];
      for (const item of files) {
        const filePath = typeof item?.path === "string" ? item.path : "";
        if (!filePath) continue;
        try {
          const content = await fs.readFile(filePath, "utf8");
          results.push({ path: filePath, content });
        } catch (error) {
          results.push({
            path: filePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { files: results };
    },
    catch: (cause) => toToolExecutionError(invocation, cause),
  });

const applyPatchAdapter: ToolAdapter = (_context, invocation) =>
  Effect.succeed({
    status: "not_implemented",
    detail:
      "apply_patch adapter requires grammar-aware patch processing and is reserved for phase 4 hardening.",
    toolName: invocation.toolName,
  });

const semanticSearchAdapter: ToolAdapter = (_context, invocation) =>
  Effect.succeed({
    status: "not_implemented",
    detail: "semantic_search adapter requires project index integration.",
    toolName: invocation.toolName,
  });

const passthroughStubAdapter: ToolAdapter = (_context, invocation) =>
  Effect.succeed({
    status: "not_implemented",
    detail: `Adapter for '${invocation.toolName}' is scaffolded and awaits external integration wiring.`,
    toolName: invocation.toolName,
  });

const makeAdapters = (terminalCommandRunner: TerminalCommandRunnerShape): Map<ToolName, ToolAdapter> => {
  const adapters = new Map<ToolName, ToolAdapter>();
  adapters.set("terminal.exec", terminalExecAdapter(terminalCommandRunner));
  adapters.set("cli.capabilities", capabilitiesAdapter);
  adapters.set("cli.rg", makeNativeCliAdapter("rg"));
  adapters.set("cli.fd", makeNativeCliAdapter("fd"));
  adapters.set("cli.jq", makeNativeCliAdapter("jq"));
  adapters.set("cli.yq", makeNativeCliAdapter("yq"));
  adapters.set("cli.git", makeNativeCliAdapter("git"));
  adapters.set("cli.gh", makeNativeCliAdapter("gh"));
  adapters.set("grep", grepAdapter);
  adapters.set("file_glob", fileGlobAdapter);
  adapters.set("read_files", readFilesAdapter);
  adapters.set("apply_patch", applyPatchAdapter);
  adapters.set("semantic_search", semanticSearchAdapter);
  adapters.set("read_skill", passthroughStubAdapter);
  adapters.set("search_warp_documentation", passthroughStubAdapter);
  adapters.set("web_search", passthroughStubAdapter);
  adapters.set("fetch_web_pages", passthroughStubAdapter);
  adapters.set("create_plan", passthroughStubAdapter);
  adapters.set("read_plans", passthroughStubAdapter);
  adapters.set("edit_plans", passthroughStubAdapter);
  adapters.set("create_todo_list", passthroughStubAdapter);
  adapters.set("add_todos", passthroughStubAdapter);
  adapters.set("read_todos", passthroughStubAdapter);
  adapters.set("mark_todo_as_done", passthroughStubAdapter);
  adapters.set("remove_todos", passthroughStubAdapter);
  adapters.set("insert_code_review_comments", passthroughStubAdapter);
  adapters.set("address_review_comments", passthroughStubAdapter);
  adapters.set("report_pr", passthroughStubAdapter);
  return adapters;
};

const makeToolRegistry = Effect.gen(function* () {
  const terminalCommandRunner = yield* TerminalCommandRunner;
  const adapters = makeAdapters(terminalCommandRunner);

  const execute: ToolRegistryShape["execute"] = (context, invocation) =>
    Effect.gen(function* () {
      const adapter = adapters.get(invocation.toolName);
      if (!adapter) {
        return yield* new ToolNotFoundError({
          toolName: invocation.toolName,
        });
      }
      return yield* adapter(context, invocation);
    });

  return {
    execute,
  } satisfies ToolRegistryShape;
});

export const ToolRegistryLive = Layer.effect(ToolRegistry, makeToolRegistry);
