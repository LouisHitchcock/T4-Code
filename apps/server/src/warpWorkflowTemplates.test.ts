import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildWarpWorkflowTemplatesFromCatalog,
  listWarpWorkflowCommandTemplates,
  parseCliToolCandidatesCatalog,
  parseWarpWorkflowCatalog,
  resetWarpWorkflowTemplateCacheForTests,
} from "./warpWorkflowTemplates.ts";

describe("parseWarpWorkflowCatalog", () => {
  it("parses category-scoped workflow entries from catalog text", () => {
    const catalogText = [
      "=== GIT ===",
      "",
      "[Set remote URL]",
      "Sets the URL for origin.",
      "git remote set-url origin {{url}}",
      "",
      "=== SHELL ===",
      "",
      "[Run loop]",
      "Iterate over a sequence.",
      "",
      "for i in {{sequence}}; do",
      "  echo $i",
      "done",
      "",
    ].join("\n");

    const parsed = parseWarpWorkflowCatalog(catalogText, "sample.txt");
    expect(parsed.issues).toEqual([]);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      category: "GIT",
      title: "Set remote URL",
      description: "Sets the URL for origin.",
      command: "git remote set-url origin {{url}}",
    });
    expect(parsed.entries[1]).toMatchObject({
      category: "SHELL",
      title: "Run loop",
      description: "Iterate over a sequence.",
      command: ["for i in {{sequence}}; do", "  echo $i", "done"].join("\n"),
    });
  });

  it("records issues for malformed entries", () => {
    const catalogText = [
      "=== GIT ===",
      "[Missing command]",
      "Only description present",
      "",
    ].join("\n");

    const parsed = parseWarpWorkflowCatalog(catalogText, "sample.txt");
    expect(parsed.entries).toEqual([]);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.relativePath).toBe("sample.txt:2");
  });
});

describe("parseCliToolCandidatesCatalog", () => {
  it("parses tool entries and prefers explicit example commands", () => {
    const catalogText = [
      "=== CORE DISCOVERY ===",
      "",
      "ripgrep / rg",
      "Priority: Core",
      "Use: Fast recursive text/code search.",
      "Agent integration: Direct",
      "Example:",
      "rg \"{{search_term}}\"",
      "",
      "fd",
      "Priority: Core",
      "Use: Fast file and directory discovery.",
      "Agent integration: Direct",
    ].join("\n");

    const parsed = parseCliToolCandidatesCatalog(catalogText, "tools.txt");
    expect(parsed.issues).toEqual([]);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      category: "CORE DISCOVERY",
      title: "ripgrep / rg",
      command: "rg \"{{search_term}}\"",
    });
    expect(parsed.entries[1]?.command).toContain("Tool: fd");
  });
});

describe("buildWarpWorkflowTemplatesFromCatalog", () => {
  it("creates deduped command templates from parsed catalog entries", () => {
    const parsed = parseWarpWorkflowCatalog(
      [
        "=== GIT ===",
        "[Status]",
        "Show git status.",
        "git status",
        "",
        "[Status]",
        "Show short status.",
        "git status --short",
      ].join("\n"),
      "sample.txt",
    );

    const result = buildWarpWorkflowTemplatesFromCatalog({ catalog: parsed, sourceLabel: "sample.txt" });
    expect(result.issues).toEqual([]);
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).toMatchObject({
      name: "git-status",
      description: "[GIT] Show git status.",
      template: "git status",
      sendImmediately: false,
    });
    expect(result.commands[1]?.name).toBe("git-status-2");
  });
});

describe("listWarpWorkflowCommandTemplates", () => {
  it("loads templates from all configured workflow catalogs", () => {
    const previousWarp = process.env.DRAFT_WARP_WORKFLOWS_FILE;
    const previousCliTools = process.env.DRAFT_CLI_TOOL_CANDIDATES_FILE;
    const previousProcess = process.env.DRAFT_AGENT_PROCESS_WORKFLOWS_FILE;
    const previousAgentCli = process.env.DRAFT_AGENT_CLI_WORKFLOWS_FILE;
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "draft-warp-workflows-"));
    const warpWorkflowsPath = path.join(tempDirectory, "warp_workflows_cleaned.txt");
    const cliToolCandidatesPath = path.join(tempDirectory, "cli_tool_candidates.txt");
    const processWorkflowsPath = path.join(tempDirectory, "agent_process_workflows.txt");
    const agentCliWorkflowsPath = path.join(tempDirectory, "agent_cli_workflows.txt");
    fs.writeFileSync(
      warpWorkflowsPath,
      [
        "=== DOCKER ===",
        "[List images]",
        "List Docker images on disk.",
        "docker image ls",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      cliToolCandidatesPath,
      [
        "=== CORE DISCOVERY ===",
        "ripgrep / rg",
        "Priority: Core",
        "Use: Fast recursive text/code search.",
        "Agent integration: Direct",
        "Example:",
        "rg \"{{search_term}}\"",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      processWorkflowsPath,
      [
        "=== AGENT DEVELOPMENT WORKFLOWS ===",
        "[Execution Plan Workflow]",
        "Use when a task is too large to safely complete in one step.",
        "Agent checklist:",
        "1. Restate goal.",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      agentCliWorkflowsPath,
      [
        "=== CODEBASE DISCOVERY ===",
        "[Find relevant code fast]",
        "Use when the agent needs to locate symbols before editing.",
        "Commands:",
        "rg \"{{search_term}}\"",
      ].join("\n"),
      "utf8",
    );

    try {
      process.env.DRAFT_WARP_WORKFLOWS_FILE = warpWorkflowsPath;
      process.env.DRAFT_CLI_TOOL_CANDIDATES_FILE = cliToolCandidatesPath;
      process.env.DRAFT_AGENT_PROCESS_WORKFLOWS_FILE = processWorkflowsPath;
      process.env.DRAFT_AGENT_CLI_WORKFLOWS_FILE = agentCliWorkflowsPath;
      resetWarpWorkflowTemplateCacheForTests();
      const result = listWarpWorkflowCommandTemplates();
      expect(result.issues).toEqual([]);
      expect(result.commands.find((command) => command.name === "docker-list-images")).toMatchObject({
        relativePath: "warp-workflows/docker/docker-list-images.md",
        template: "docker image ls",
      });
      expect(
        result.commands.find((command) => command.name === "core-discovery-ripgrep-rg"),
      ).toMatchObject({
        relativePath: "cli-tool-candidates/core-discovery/core-discovery-ripgrep-rg.md",
        template: "rg \"{{search_term}}\"",
      });
      expect(
        result.commands.find(
          (command) => command.name === "agent-development-workflows-execution-plan-workflow",
        ),
      ).toMatchObject({
        relativePath:
          "agent-process-workflows/agent-development-workflows/agent-development-workflows-execution-plan-workflow.md",
      });
      expect(
        result.commands.find((command) => command.name === "codebase-discovery-find-relevant-code-fast"),
      ).toMatchObject({
        relativePath:
          "agent-cli-workflows/codebase-discovery/codebase-discovery-find-relevant-code-fast.md",
      });
    } finally {
      if (previousWarp === undefined) {
        delete process.env.DRAFT_WARP_WORKFLOWS_FILE;
      } else {
        process.env.DRAFT_WARP_WORKFLOWS_FILE = previousWarp;
      }
      if (previousCliTools === undefined) {
        delete process.env.DRAFT_CLI_TOOL_CANDIDATES_FILE;
      } else {
        process.env.DRAFT_CLI_TOOL_CANDIDATES_FILE = previousCliTools;
      }
      if (previousProcess === undefined) {
        delete process.env.DRAFT_AGENT_PROCESS_WORKFLOWS_FILE;
      } else {
        process.env.DRAFT_AGENT_PROCESS_WORKFLOWS_FILE = previousProcess;
      }
      if (previousAgentCli === undefined) {
        delete process.env.DRAFT_AGENT_CLI_WORKFLOWS_FILE;
      } else {
        process.env.DRAFT_AGENT_CLI_WORKFLOWS_FILE = previousAgentCli;
      }
      resetWarpWorkflowTemplateCacheForTests();
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
