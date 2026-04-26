import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listProjectCommandTemplates } from "./projectWorkspaceMetadata.ts";
import { resetWarpWorkflowTemplateCacheForTests } from "./warpWorkflowTemplates.ts";

describe("listProjectCommandTemplates", () => {
  it("keeps project templates when built-in workflow names collide", () => {
    const previousWorkflowPath = process.env.DRAFT_WARP_WORKFLOWS_FILE;
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "draft-command-templates-"));
    const commandsDirectory = path.join(workspaceDirectory, ".draft", "commands");
    const workflowsFilePath = path.join(workspaceDirectory, "warp_workflows_cleaned.txt");

    fs.mkdirSync(commandsDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDirectory, "git-status.md"),
      ["---", "description: Local git status template.", "---", "git status --short"].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      workflowsFilePath,
      [
        "=== GIT ===",
        "[Status]",
        "Built-in status template.",
        "git status",
        "",
        "[Log]",
        "Built-in log template.",
        "git log --oneline",
      ].join("\n"),
      "utf8",
    );

    try {
      process.env.DRAFT_WARP_WORKFLOWS_FILE = workflowsFilePath;
      resetWarpWorkflowTemplateCacheForTests();

      const result = listProjectCommandTemplates({ cwd: workspaceDirectory });
      const statusCommands = result.commands.filter((command) => command.name === "git-status");
      expect(statusCommands).toHaveLength(1);
      expect(statusCommands[0]?.relativePath).toBe(".draft/commands/git-status.md");
      expect(statusCommands[0]?.template).toBe("git status --short");
      expect(result.commands.find((command) => command.name === "git-log")).toMatchObject({
        description: "[GIT] Built-in log template.",
        template: "git log --oneline",
      });
      expect(
        result.issues.some((issue) =>
          issue.message.includes(
            "Skipped built-in workflow template 'git-status' because a project template already uses that name.",
          ),
        ),
      ).toBe(true);
    } finally {
      if (previousWorkflowPath === undefined) {
        delete process.env.DRAFT_WARP_WORKFLOWS_FILE;
      } else {
        process.env.DRAFT_WARP_WORKFLOWS_FILE = previousWorkflowPath;
      }
      resetWarpWorkflowTemplateCacheForTests();
      fs.rmSync(workspaceDirectory, { recursive: true, force: true });
    }
  });
});
