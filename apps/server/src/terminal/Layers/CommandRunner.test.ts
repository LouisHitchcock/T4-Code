import {
  DEFAULT_TERMINAL_ID,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalExecEvent,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { type TerminalManagerShape } from "../Services/Manager";
import { TerminalCommandRunnerRuntime } from "./CommandRunner";

class FakeTerminalManager implements TerminalManagerShape {
  readonly openCalls: TerminalOpenInput[] = [];

  constructor(
    private readonly openSnapshotFactory: (input: TerminalOpenInput) => TerminalSessionSnapshot = (
      input,
    ) => ({
      threadId: input.threadId,
      terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
      cwd: input.cwd,
      status: "running",
      pid: 4242,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: new Date().toISOString(),
    }),
    private readonly openErrorFactory?: (input: TerminalOpenInput, attempt: number) => Error | null,
  ) {}

  readonly open: TerminalManagerShape["open"] = (input) =>
    Effect.sync(() => {
      this.openCalls.push(input);
      const failure = this.openErrorFactory?.(input, this.openCalls.length);
      if (failure) {
        throw failure;
      }
      return this.openSnapshotFactory(input);
    });

  readonly write: TerminalManagerShape["write"] = (_input: TerminalWriteInput) => Effect.void;
  readonly resize: TerminalManagerShape["resize"] = (_input: TerminalResizeInput) => Effect.void;
  readonly clear: TerminalManagerShape["clear"] = (_input: TerminalClearInput) => Effect.void;
  readonly restart: TerminalManagerShape["restart"] = (input: TerminalRestartInput) =>
    this.open(input);
  readonly close: TerminalManagerShape["close"] = (_input: TerminalCloseInput) => Effect.void;
  readonly subscribe: TerminalManagerShape["subscribe"] = (_listener) =>
    Effect.sync(() => {
      return () => {
        // no-op
      };
    });
  readonly dispose: TerminalManagerShape["dispose"] = Effect.void;
}

describe("TerminalCommandRunnerRuntime", () => {
  it("executes wait-mode commands and emits lifecycle events", async () => {
    const runtime = new TerminalCommandRunnerRuntime(new FakeTerminalManager());
    const events: TerminalExecEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => {
      events.push(event);
    });

    try {
      const result = await runtime.exec({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: process.cwd(),
        mode: "wait",
        command: process.execPath,
        args: ["-e", "process.stdout.write('hello\\n'); process.stderr.write('warn\\n');"],
        isReadOnly: true,
        reason: "wait mode test",
      });

      expect(result.mode).toBe("wait");
      if (result.mode !== "wait") return;
      expect(result.status).toBe("succeeded");
      expect(result.stdout).toContain("hello");
      expect(result.stderr).toContain("warn");
      expect(result.metadata).toMatchObject({
        isReadOnly: true,
        isRisky: false,
        usesPager: false,
        reason: "wait mode test",
      });

      const started = events.find((event) => event.type === "exec.started");
      expect(started).toBeDefined();
      if (started && started.type === "exec.started") {
        expect(started.commandId).toBe(result.commandId);
      }

      const completed = events.find((event) => event.type === "exec.completed");
      expect(completed).toBeDefined();
      if (completed && completed.type === "exec.completed") {
        expect(completed.result.commandId).toBe(result.commandId);
      }

      const outputStreams = events
        .filter((event): event is Extract<TerminalExecEvent, { type: "exec.output" }> => {
          return event.type === "exec.output";
        })
        .map((event) => event.stream);
      expect(outputStreams).toEqual(expect.arrayContaining(["stdout", "stderr"]));
    } finally {
      unsubscribe();
    }
  });

  it("returns timed_out for wait-mode timeout", async () => {
    const runtime = new TerminalCommandRunnerRuntime(new FakeTerminalManager());

    const result = await runtime.exec({
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: process.cwd(),
      mode: "wait",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000);"],
      timeoutMs: 30,
    });

    expect(result.mode).toBe("wait");
    if (result.mode !== "wait") return;
    expect(result.status).toBe("timed_out");
    expect(result.timedOut).toBe(true);
  });

  it("runs shell-expression wait commands through a shell wrapper", async () => {
    const runtime = new TerminalCommandRunnerRuntime(new FakeTerminalManager());

    const result = await runtime.exec({
      threadId: "thread-1",
      terminalId: DEFAULT_TERMINAL_ID,
      cwd: process.cwd(),
      mode: "wait",
      command: "echo command-runner-shell-fallback",
    });

    expect(result.mode).toBe("wait");
    if (result.mode !== "wait") return;
    expect(result.status).toBe("succeeded");
    expect(result.stdout.toLowerCase()).toContain("command-runner-shell-fallback");
  });

  it("rejects risky commands without explicit approval and emits an error event", async () => {
    const runtime = new TerminalCommandRunnerRuntime(new FakeTerminalManager());
    const events: TerminalExecEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => {
      events.push(event);
    });

    try {
      await expect(
        runtime.exec({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cwd: process.cwd(),
          mode: "wait",
          command: process.execPath,
          args: ["-e", "process.exit(0);"],
          isRisky: true,
          approveRiskyExecution: false,
        }),
      ).rejects.toThrow("approveRiskyExecution");

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("exec.error");
    } finally {
      unsubscribe();
    }
  });

  it("uses terminal manager open for interact mode and emits completion events", async () => {
    const terminalManager = new FakeTerminalManager((input) => ({
      threadId: input.threadId,
      terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
      cwd: input.cwd,
      status: "running",
      pid: 7777,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: new Date().toISOString(),
    }));
    const runtime = new TerminalCommandRunnerRuntime(terminalManager);
    const events: TerminalExecEvent[] = [];
    const unsubscribe = runtime.subscribe((event) => {
      events.push(event);
    });

    try {
      const result = await runtime.exec({
        threadId: "thread-interact",
        terminalId: "terminal-2",
        cwd: process.cwd(),
        mode: "interact",
        command: "bash",
        args: ["-lc", "echo hi"],
        cols: 140,
        rows: 42,
        env: { CUSTOM_FLAG: "1" },
      });

      expect(result.mode).toBe("interact");
      expect(result.status).toBe("running");
      expect(terminalManager.openCalls).toHaveLength(1);
      expect(terminalManager.openCalls[0]).toMatchObject({
        threadId: "thread-interact",
        terminalId: "terminal-2",
        command: "bash",
        args: ["-lc", "echo hi"],
      });

      const completed = events.find((event) => event.type === "exec.completed");
      expect(completed).toBeDefined();
      if (completed && completed.type === "exec.completed") {
        expect(completed.result.commandId).toBe(result.commandId);
      }
    } finally {
      unsubscribe();
    }
  });

  it("wraps shell-expression interact commands before opening a PTY", async () => {
    const terminalManager = new FakeTerminalManager((input) => ({
      threadId: input.threadId,
      terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
      cwd: input.cwd,
      status: "running",
      pid: 31337,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: new Date().toISOString(),
    }));
    const runtime = new TerminalCommandRunnerRuntime(terminalManager);

    const result = await runtime.exec({
      threadId: "thread-interact",
      terminalId: "terminal-2",
      cwd: process.cwd(),
      mode: "interact",
      command: "cd /",
    });

    expect(result.mode).toBe("interact");
    expect(result.status).toBe("running");
    expect(terminalManager.openCalls).toHaveLength(1);
    const shellWrappedOpen = terminalManager.openCalls[0];
    if (!shellWrappedOpen) return;
    if (process.platform === "win32") {
      expect(shellWrappedOpen.command).toBe("powershell.exe");
      expect(shellWrappedOpen.args?.[0]).toBe("-NoLogo");
      expect(shellWrappedOpen.args?.[1]).toBe("-NoProfile");
      expect(shellWrappedOpen.args?.[2]).toBe("-Command");
      expect(shellWrappedOpen.args?.[3]).toBe("cd /");
    } else {
      expect(shellWrappedOpen.command).toBe("/bin/sh");
      expect(shellWrappedOpen.args).toEqual(["-lc", "cd /"]);
    }
  });
});
