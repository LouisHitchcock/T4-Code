import { EventEmitter } from "node:events";

import { TerminalExecEvent, TerminalExecInput, TerminalExecResult } from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";

import { runProcess } from "../../processRunner";
import {
  TerminalCommandRunner,
  TerminalCommandRunnerError,
  TerminalCommandRunnerShape,
} from "../Services/CommandRunner";
import { TerminalManager, type TerminalManagerShape } from "../Services/Manager";
import { createTerminalSpawnEnv, normalizedRuntimeEnv } from "../terminalEnv";

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const WINDOWS_SHELL_BUILTINS = new Set([
  "cd",
  "dir",
  "echo",
  "set",
  "ver",
  "cls",
  "copy",
  "del",
  "move",
  "type",
]);
const POSIX_SHELL_BUILTINS = new Set(["cd", "alias", "export", "set", "unset", "source", "."]);

const decodeTerminalExecInput = Schema.decodeUnknownSync(TerminalExecInput);

interface TerminalCommandRunnerEvents {
  event: [event: TerminalExecEvent];
}

function normalizeExecErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Terminal command execution failed";
}

function completedAt(): string {
  return new Date().toISOString();
}

function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isLikelyShellExpression(command: string, args: ReadonlyArray<string>): boolean {
  if (args.length > 0) {
    return false;
  }
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (/[|&;<>()]/.test(trimmed) || /\s/.test(trimmed)) {
    return true;
  }
  const [firstToken] = trimmed.split(/\s+/g);
  if (!firstToken) {
    return false;
  }
  const normalizedToken = firstToken.toLowerCase();
  if (process.platform === "win32") {
    return WINDOWS_SHELL_BUILTINS.has(normalizedToken);
  }
  return POSIX_SHELL_BUILTINS.has(normalizedToken);
}

function buildShellWrappedLaunch(
  command: string,
  args: ReadonlyArray<string>,
): {
  command: string;
  args: string[];
} {
  if (process.platform === "win32") {
    const expression =
      args.length === 0
        ? command
        : `& ${quotePowerShellLiteral(command)} ${args.map(quotePowerShellLiteral).join(" ")}`;
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", expression],
    };
  }
  const expression =
    args.length === 0
      ? command
      : `${quotePosixShell(command)} ${args.map(quotePosixShell).join(" ")}`;
  return {
    command: "/bin/sh",
    args: ["-lc", expression],
  };
}

type TerminalExecMetadata = {
  isReadOnly: boolean;
  isRisky: boolean;
  usesPager: boolean;
  reason: string | null;
};

function resolveExecMetadata(input: TerminalExecInput): TerminalExecMetadata {
  return {
    isReadOnly: input.isReadOnly ?? false,
    isRisky: input.isRisky ?? false,
    usesPager: input.usesPager ?? false,
    reason: input.reason ?? null,
  };
}

export class TerminalCommandRunnerRuntime extends EventEmitter<TerminalCommandRunnerEvents> {
  constructor(private readonly terminalManager: TerminalManagerShape) {
    super();
  }

  subscribe(listener: (event: TerminalExecEvent) => void): () => void {
    this.on("event", listener);
    return () => {
      this.off("event", listener);
    };
  }

  async exec(raw: TerminalExecInput): Promise<TerminalExecResult> {
    const input = decodeTerminalExecInput(raw);
    const startedDate = new Date();
    const startedAt = startedDate.toISOString();
    const commandId = `terminal-exec-${crypto.randomUUID()}`;
    const args = input.args ? [...input.args] : [];
    const metadata = resolveExecMetadata(input);
    const eventBase = {
      threadId: input.threadId,
      terminalId: input.terminalId,
      commandId,
    } as const;
    const resultBase = {
      threadId: input.threadId,
      terminalId: input.terminalId,
      commandId,
      command: input.command,
      args,
      cwd: input.cwd,
      startedAt,
      metadata,
    } as const;

    if (metadata.isRisky && !input.approveRiskyExecution) {
      const message = "Risky command execution requires approveRiskyExecution=true.";
      this.emitEvent({
        ...eventBase,
        mode: input.mode,
        type: "exec.error",
        createdAt: completedAt(),
        message,
      });
      throw new Error(message);
    }

    this.emitEvent({
      ...eventBase,
      mode: input.mode,
      type: "exec.started",
      createdAt: startedAt,
      command: input.command,
      args,
      cwd: input.cwd,
      metadata,
    });

    if (input.mode === "interact") {
      const interactInput = {
        ...input,
        mode: "interact",
      } as const;
      return this.execInteract(
        interactInput,
        resultBase,
        {
          ...eventBase,
          mode: "interact",
        },
        completedAt,
      );
    }
    const waitInput = {
      ...input,
      mode: "wait",
    } as const;
    return this.execWait(
      waitInput,
      resultBase,
      {
        ...eventBase,
        mode: "wait",
      },
      startedDate.getTime(),
      completedAt,
    );
  }

  private async execInteract(
    input: TerminalExecInput & { mode: "interact" },
    resultBase: {
      threadId: string;
      terminalId: string;
      commandId: string;
      command: string;
      args: string[];
      cwd: string;
      startedAt: string;
      metadata: TerminalExecMetadata;
    },
    eventBase: {
      threadId: string;
      terminalId: string;
      commandId: string;
      mode: "interact";
    },
    completedAt: () => string,
  ): Promise<TerminalExecResult> {
    try {
      const directArgs = input.args ? [...input.args] : [];
      const wrappedLaunch = isLikelyShellExpression(input.command, directArgs)
        ? buildShellWrappedLaunch(input.command, directArgs)
        : null;
      const launchCommand = wrappedLaunch?.command ?? input.command;
      const launchArgs = wrappedLaunch?.args ?? directArgs;
      const snapshot = await Effect.runPromise(
        this.terminalManager.open({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          ...(input.cols !== undefined ? { cols: input.cols } : {}),
          ...(input.rows !== undefined ? { rows: input.rows } : {}),
          command: launchCommand,
          ...(launchArgs.length > 0 ? { args: launchArgs } : {}),
          ...(input.env ? { env: input.env } : {}),
        }),
      );
      const result = {
        ...resultBase,
        mode: "interact",
        status: "running",
        snapshot,
      } satisfies TerminalExecResult;
      this.emitEvent({
        ...eventBase,
        type: "exec.completed",
        createdAt: completedAt(),
        result,
      });
      return result;
    } catch (error) {
      this.emitEvent({
        ...eventBase,
        type: "exec.error",
        createdAt: completedAt(),
        message: normalizeExecErrorMessage(error),
      });
      throw error;
    }
  }

  private async execWait(
    input: TerminalExecInput & { mode: "wait" },
    resultBase: {
      threadId: string;
      terminalId: string;
      commandId: string;
      command: string;
      args: string[];
      cwd: string;
      startedAt: string;
      metadata: TerminalExecMetadata;
    },
    eventBase: {
      threadId: string;
      terminalId: string;
      commandId: string;
      mode: "wait";
    },
    startedAtMs: number,
    completedAt: () => string,
  ): Promise<TerminalExecResult> {
    try {
      const directArgs = input.args ? [...input.args] : [];
      const wrappedLaunch = isLikelyShellExpression(input.command, directArgs)
        ? buildShellWrappedLaunch(input.command, directArgs)
        : null;
      const launchCommand = wrappedLaunch?.command ?? input.command;
      const launchArgs = wrappedLaunch?.args ?? directArgs;
      const spawnEnv = createTerminalSpawnEnv(process.env, normalizedRuntimeEnv(input.env));
      const waitResult = await runProcess(launchCommand, launchArgs, {
        cwd: input.cwd,
        env: spawnEnv,
        timeoutMs: input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
        allowNonZeroExit: true,
        outputMode: "truncate",
      });

      if (waitResult.stdout.length > 0) {
        this.emitEvent({
          ...eventBase,
          type: "exec.output",
          createdAt: completedAt(),
          stream: "stdout",
          data: waitResult.stdout,
        });
      }
      if (waitResult.stderr.length > 0) {
        this.emitEvent({
          ...eventBase,
          type: "exec.output",
          createdAt: completedAt(),
          stream: "stderr",
          data: waitResult.stderr,
        });
      }

      const result = {
        ...resultBase,
        mode: "wait",
        status: waitResult.timedOut ? "timed_out" : waitResult.code === 0 ? "succeeded" : "failed",
        completedAt: completedAt(),
        durationMs: Math.max(0, Date.now() - startedAtMs),
        exitCode: waitResult.code,
        exitSignal: waitResult.signal,
        timedOut: waitResult.timedOut,
        stdout: waitResult.stdout,
        stderr: waitResult.stderr,
        stdoutTruncated: waitResult.stdoutTruncated === true,
        stderrTruncated: waitResult.stderrTruncated === true,
      } satisfies TerminalExecResult;

      this.emitEvent({
        ...eventBase,
        type: "exec.completed",
        createdAt: completedAt(),
        result,
      });
      return result;
    } catch (error) {
      this.emitEvent({
        ...eventBase,
        type: "exec.error",
        createdAt: completedAt(),
        message: normalizeExecErrorMessage(error),
      });
      throw error;
    }
  }

  private emitEvent(event: TerminalExecEvent): void {
    this.emit("event", event);
  }
}

export const TerminalCommandRunnerLive = Layer.effect(
  TerminalCommandRunner,
  Effect.gen(function* () {
    const terminalManager = yield* TerminalManager;
    const runtime = new TerminalCommandRunnerRuntime(terminalManager);
    return {
      exec: (input) =>
        Effect.tryPromise({
          try: () => runtime.exec(input),
          catch: (cause) =>
            new TerminalCommandRunnerError({
              message: "Failed to execute terminal command",
              cause,
            }),
        }),
      subscribe: (listener) => Effect.sync(() => runtime.subscribe(listener)),
    } satisfies TerminalCommandRunnerShape;
  }),
);
