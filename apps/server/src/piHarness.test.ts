import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createLockedPiSettingsManager, createPiHarnessCatalogSnapshot } from "./piHarness.ts";

describe("createLockedPiSettingsManager", () => {
  it("preserves Pi runtime defaults while stripping package and resource discovery settings", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cut3-pi-settings-"));
    const agentDir = path.join(cwd, "agent");
    const projectPiDir = path.join(cwd, ".pi");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(projectPiDir, { recursive: true });

    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        defaultThinkingLevel: "medium",
        packages: ["npm:global-package"],
        extensions: ["./extensions"],
        skills: ["./skills"],
        prompts: ["./prompts"],
        themes: ["./themes"],
        enableSkillCommands: true,
        compaction: {
          enabled: false,
          reserveTokens: 111,
        },
        retry: {
          enabled: false,
          maxRetries: 1,
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectPiDir, "settings.json"),
      JSON.stringify({
        defaultModel: "gpt-5.5",
        defaultThinkingLevel: "high",
        packages: ["npm:project-package"],
        extensions: ["./project-extensions"],
        compaction: {
          reserveTokens: 222,
        },
        retry: {
          maxRetries: 3,
        },
      }),
      "utf8",
    );

    const settingsManager = createLockedPiSettingsManager({ cwd, agentDir });

    expect(settingsManager.getDefaultProvider()).toBe("openai");
    expect(settingsManager.getDefaultModel()).toBe("gpt-5.5");
    expect(settingsManager.getDefaultThinkingLevel()).toBe("high");
    expect(settingsManager.getPackages()).toEqual([]);
    expect(settingsManager.getExtensionPaths()).toEqual([]);
    expect(settingsManager.getSkillPaths()).toEqual([]);
    expect(settingsManager.getPromptTemplatePaths()).toEqual([]);
    expect(settingsManager.getThemePaths()).toEqual([]);
    expect(settingsManager.getEnableSkillCommands()).toBe(false);
    expect(settingsManager.getCompactionSettings().reserveTokens).toBe(222);
    expect(settingsManager.getRetrySettings().maxRetries).toBe(3);
  });
});

describe("createPiHarnessCatalogSnapshot", () => {
  it("honors PI_CODING_AGENT_DIR when no explicit agentDir is passed", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cut3-pi-catalog-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = cwd;

    try {
      fs.writeFileSync(
        path.join(cwd, "auth.json"),
        JSON.stringify({
          openai: {
            type: "api_key",
            key: "sk-test",
          },
        }),
        "utf8",
      );

      const snapshot = createPiHarnessCatalogSnapshot();
      expect(snapshot.agentDir).toBe(cwd);
      expect(snapshot.authProviders).toContain("openai");
    } finally {
      if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      }
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
