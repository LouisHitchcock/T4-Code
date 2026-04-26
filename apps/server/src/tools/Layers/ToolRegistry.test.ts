import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import {
  TerminalCommandRunner,
  TerminalCommandRunnerError,
  type TerminalCommandRunnerShape,
} from "../../terminal/Services/CommandRunner.ts";
import { ToolRegistry } from "../Services/ToolRegistry.ts";
import { resetNativeCliAvailabilityCacheForTests, ToolRegistryLive } from "./ToolRegistry.ts";

const terminalCommandRunnerStub: TerminalCommandRunnerShape = {
  exec: () =>
    Effect.fail(
      new TerminalCommandRunnerError({
        message: "terminal.exec should not be called in ToolRegistry tests",
      }),
    ),
  subscribe: () => Effect.succeed(() => {}),
};

const makeRegistry = () =>
  Effect.gen(function* () {
    return yield* ToolRegistry;
  }).pipe(
    Effect.provide(
      ToolRegistryLive.pipe(
        Layer.provide(Layer.succeed(TerminalCommandRunner, terminalCommandRunnerStub)),
      ),
    ),
  );

describe("ToolRegistryLive", () => {
  beforeEach(() => {
    resetNativeCliAvailabilityCacheForTests();
  });

  it("returns native CLI capabilities for phase 1 commands", async () => {
    const registry = await Effect.runPromise(makeRegistry());
    const output = await Effect.runPromise(
      registry.execute(
        { threadId: "thread-1" },
        {
          toolCallId: "call-1",
          toolName: "cli.capabilities",
          input: {},
        },
      ),
    );

    const capabilities = output as {
      tools: Record<string, { available: boolean; path: string | null }>;
    };
    expect(capabilities.tools).toMatchObject({
      rg: expect.any(Object),
      fd: expect.any(Object),
      jq: expect.any(Object),
      yq: expect.any(Object),
      git: expect.any(Object),
      gh: expect.any(Object),
    });
    expect(typeof capabilities.tools.rg?.available).toBe("boolean");
  });

  it("searches with grep adapter and returns matching lines", async () => {
    const registry = await Effect.runPromise(makeRegistry());
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "draft-tool-registry-grep-"));
    const filePath = path.join(tempRoot, "notes.txt");
    try {
      await fs.writeFile(filePath, "alpha\nneedle\nomega\n", "utf8");
      const output = await Effect.runPromise(
        registry.execute(
          { threadId: "thread-2" },
          {
            toolCallId: "call-1",
            toolName: "grep",
            input: {
              cwd: tempRoot,
              query: "needle",
              maxMatches: 10,
            },
          },
        ),
      );

      const result = output as {
        matches: Array<{ file: string; line: number; text: string }>;
        backend: "rg" | "filesystem";
      };
      expect(result.backend === "rg" || result.backend === "filesystem").toBe(true);
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0]).toMatchObject({
        file: filePath,
        line: 2,
        text: "needle",
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies minDepth filtering in file_glob adapter", async () => {
    const registry = await Effect.runPromise(makeRegistry());
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "draft-tool-registry-glob-"));
    const rootFile = path.join(tempRoot, "root.txt");
    const nestedDir = path.join(tempRoot, "nested");
    const nestedFile = path.join(nestedDir, "child.txt");
    const originalPath = process.env.PATH;

    try {
      process.env.PATH = "";
      resetNativeCliAvailabilityCacheForTests();
      await fs.mkdir(nestedDir, { recursive: true });
      await fs.writeFile(rootFile, "root", "utf8");
      await fs.writeFile(nestedFile, "child", "utf8");

      const allDepthsOutput = await Effect.runPromise(
        registry.execute(
          { threadId: "thread-3" },
          {
            toolCallId: "call-1",
            toolName: "file_glob",
            input: {
              searchDir: tempRoot,
              patterns: ["*.txt"],
              minDepth: 0,
              maxMatches: 10,
            },
          },
        ),
      );
      const deeperOnlyOutput = await Effect.runPromise(
        registry.execute(
          { threadId: "thread-3" },
          {
            toolCallId: "call-2",
            toolName: "file_glob",
            input: {
              searchDir: tempRoot,
              patterns: ["*.txt"],
              minDepth: 2,
              maxMatches: 10,
            },
          },
        ),
      );

      const allDepthsResult = allDepthsOutput as {
        matchedFiles: string[];
        backend: "fd" | "filesystem";
      };
      const deeperOnlyResult = deeperOnlyOutput as {
        matchedFiles: string[];
        backend: "fd" | "filesystem";
      };
      expect(allDepthsResult.backend).toBe("filesystem");
      expect(deeperOnlyResult.backend).toBe("filesystem");
      expect(allDepthsResult.matchedFiles).toContain(rootFile);
      expect(deeperOnlyResult.matchedFiles).not.toContain(rootFile);
      expect(deeperOnlyResult.matchedFiles.length).toBeLessThanOrEqual(
        allDepthsResult.matchedFiles.length,
      );
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      resetNativeCliAvailabilityCacheForTests();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
