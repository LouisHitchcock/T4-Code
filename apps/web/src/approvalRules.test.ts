import { ApprovalRequestId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  cloneApprovalPresetRules,
  createBlankApprovalRule,
  findMatchingApprovalRule,
  normalizeApprovalRules,
} from "./approvalRules";

describe("normalizeApprovalRules", () => {
  it("trims fields, fills defaults, and ignores duplicate ids", () => {
    expect(
      normalizeApprovalRules([
        {
          id: "rule-1",
          label: "  Allow reads  ",
          enabled: true,
          scope: "project",
          projectId: "project-1",
          requestKinds: [],
          requestTypeTerms: "  file_read_approval  ",
          matchText: "  README  ",
          action: "allow",
        },
        {
          id: "rule-1",
          label: "duplicate",
        },
      ]),
    ).toEqual([
      {
        id: "rule-1",
        label: "Allow reads",
        enabled: true,
        scope: "project",
        projectId: "project-1",
        requestKinds: ["command", "file-read", "file-change"],
        requestTypeTerms: "file_read_approval",
        matchText: "README",
        action: "allow",
      },
    ]);
  });
});

describe("findMatchingApprovalRule", () => {
  it("matches project-scoped rules before broader app rules when ordered first", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const rules = normalizeApprovalRules([
      {
        id: "rule-project",
        label: "Deny writes in trusted review thread",
        enabled: true,
        scope: "project",
        projectId,
        requestKinds: ["file-change"],
        requestTypeTerms: "apply_patch_approval",
        matchText: "src/",
        action: "deny",
      },
      {
        id: "rule-app",
        label: "Ask on every write",
        enabled: true,
        scope: "app",
        projectId: null,
        requestKinds: ["file-change"],
        requestTypeTerms: "",
        matchText: "",
        action: "ask",
      },
    ]);

    const matched = findMatchingApprovalRule({
      rules,
      approval: {
        requestId: ApprovalRequestId.makeUnsafe("req-1"),
        requestKind: "file-change",
        createdAt: "2026-03-21T00:00:00.000Z",
        requestType: "apply_patch_approval",
        detail: "Modify src/routes/_chat.settings.tsx",
      },
      activeProjectId: projectId,
    });

    expect(matched?.id).toBe("rule-project");
  });

  it("matches request type and detail terms against unknown approval kinds", () => {
    const rules = normalizeApprovalRules([
      {
        id: "rule-other",
        label: "Auto-approve subagent launches",
        enabled: true,
        scope: "app",
        projectId: null,
        requestKinds: ["other"],
        requestTypeTerms: "subagent_launch_approval",
        matchText: "delegate search",
        action: "allow",
      },
    ]);

    const matched = findMatchingApprovalRule({
      rules,
      approval: {
        requestId: ApprovalRequestId.makeUnsafe("req-2"),
        requestKind: "other",
        createdAt: "2026-03-21T00:00:00.000Z",
        requestType: "subagent_launch_approval",
        detail: "delegate search to background helper",
      },
      activeProjectId: null,
    });

    expect(matched?.id).toBe("rule-other");
  });
});

describe("cloneApprovalPresetRules", () => {
  it("creates fresh preset ids and can scope them to a project", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const rules = cloneApprovalPresetRules("plan", projectId);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).not.toBe("plan-read");
    expect(rules[0]).toMatchObject({
      scope: "project",
      projectId,
      action: "allow",
      requestKinds: ["file-read"],
    });
  });

  it("creates blank rules with project-aware defaults", () => {
    const projectId = ProjectId.makeUnsafe("project-2");
    expect(createBlankApprovalRule(projectId)).toMatchObject({
      scope: "project",
      projectId,
      action: "ask",
    });
  });
});
